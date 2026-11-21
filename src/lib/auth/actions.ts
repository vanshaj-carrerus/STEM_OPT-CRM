"use server";

import { requestHeaders as headers } from "@/lib/request-context";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { User, type IUser } from "@/lib/db/models/user";
import { hashPassword, verifyPassword, checkPasswordStrength } from "./password";
import { issueOtp, verifyOtp } from "./otp";
import { rateLimit } from "./ratelimit";
import { LOGIN_FAILED_MESSAGE, clearFailedLogins, isLocked, registerFailedLogin, LOCK_MINUTES, MAX_FAILED_LOGINS } from "./lockout";
import {
  createSession,
  destroyAllSessionsFor,
  destroyCurrentSession,
  destroyOtherSessionsFor,
  getPendingOtpSession,
  getSessionUser,
  promoteSession,
} from "./session";
import { audit } from "@/lib/audit";
import { toMailError } from "@/lib/mail";

export interface FormState {
  error?: string;
  message?: string;
  step?: "request" | "reset";
  email?: string;
}

// Pre-computed so unknown-email / locked / inactive logins cost the same as real ones (no enumeration by timing).
let dummyHash: Promise<string> | null = null;

const RESET_REQUEST_MESSAGE = "If that account exists, a reset code has been emailed.";

async function clientIp() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "unknown";
}

/**
 * Run slow work (sending an email) AFTER the response is sent, so the response time of "forgot password" is the same
 * whether or not the account exists. Outside a Next.js request (tests, scripts) it simply runs inline.
 */
async function deferTask(fn: () => Promise<void>) {
  const safe = async () => {
    try {
      await fn();
    } catch (err) {
      console.error("[auth] deferred task failed:", toMailError(err).message);
    }
  };
  try {
    after(safe);
  } catch {
    await safe();
  }
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(256),
});

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "Enter a valid email and password." };
  const { email, password } = parsed.data;

  const ip = await clientIp();
  const [byIp, byEmail] = await Promise.all([
    rateLimit(`login:ip:${ip}`, 20, 15 * 60),
    rateLimit(`login:email:${email}`, 8, 15 * 60),
  ]);
  if (!byIp.allowed || !byEmail.allowed) {
    return { error: "Too many sign-in attempts. Please wait a few minutes and try again." };
  }

  await connectDb();
  const user = await User.findOne({ email });

  // Always do exactly one password hash, whatever the account state, so timing reveals nothing.
  dummyHash ??= hashPassword("dummy-password-for-timing");
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));

  if (!user) {
    await audit({ action: "login_failed", entityType: "user", summary: `Unknown email attempted: ${email}`, source: "ui" });
    return { error: LOGIN_FAILED_MESSAGE };
  }
  if (isLocked(user)) {
    // Locked: even the CORRECT password is refused, the lock is not extended, and the response is the generic one.
    await audit({ action: "login_failed", entityType: "user", entityId: user._id, summary: "Sign-in attempt while account is locked", source: "ui" });
    return { error: LOGIN_FAILED_MESSAGE };
  }
  if (!passwordOk) {
    const state = await registerFailedLogin(user._id);
    await audit({
      action: "login_failed",
      entityType: "user",
      entityId: user._id,
      summary: state.justLocked ? `Account locked for ${LOCK_MINUTES} minutes after ${MAX_FAILED_LOGINS} failed attempts` : `Wrong password (${state.failedLogins}/${MAX_FAILED_LOGINS})`,
      source: "ui",
    });
    return { error: LOGIN_FAILED_MESSAGE };
  }
  if (!user.active) {
    await audit({ action: "login_failed", entityType: "user", entityId: user._id, summary: "Sign-in attempt on a disabled account", source: "ui" });
    return { error: LOGIN_FAILED_MESSAGE };
  }

  await clearFailedLogins(user._id);
  // Stage 1 session: password verified, but it grants NO access to the app until the emailed code is entered.
  const session = await createSession(user._id, "otp");
  try {
    await issueOtp(user, "login", session._id);
  } catch (err) {
    console.error("[auth] Failed to send login OTP email:", toMailError(err).message);
    await destroyCurrentSession();
    return { error: "We could not send the verification email. Please try again, or contact your administrator." };
  }
  await audit({ action: "otp_sent", entityType: "user", entityId: user._id, summary: "Login OTP emailed", source: "ui" });
  redirect("/verify-otp");
}

const otpSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code.") });

export async function verifyOtpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = otpSchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const pending = await getPendingOtpSession();
  if (!pending) redirect("/login");

  const rl = await rateLimit(`otp:${pending.userId}`, 10, 15 * 60);
  if (!rl.allowed) return { error: "Too many attempts. Please wait and try again." };

  // the code is only valid for the sign-in attempt that requested it
  const result = await verifyOtp(pending.userId, "login", parsed.data.code, { sessionId: pending._id });
  if (result !== "ok") {
    const msg =
      result === "expired"
        ? "That code is invalid or has expired. Request a new one."
        : result === "too_many_attempts"
          ? "Too many incorrect codes. Request a new one."
          : "Incorrect code. Please try again.";
    return { error: msg };
  }

  const user = await User.findById(pending.userId).lean<IUser>();
  if (!user || !user.active) redirect("/login");
  await promoteSession(pending._id, user._id);
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date(), emailVerified: true } });
  await audit({
    actor: { id: user._id, role: user.role, email: user.email },
    action: "login",
    entityType: "user",
    entityId: user._id,
    summary: "Signed in (password + email OTP)",
  });
  redirect(user.mustChangePassword ? "/change-password" : "/dashboard");
}

export async function resendOtpAction(): Promise<FormState> {
  const pending = await getPendingOtpSession();
  if (!pending) redirect("/login");
  // 30-second cooldown between codes, and at most 3 per 10 minutes
  const cooldown = await rateLimit(`otp-resend-cd:${pending.userId}`, 1, 30);
  if (!cooldown.allowed) return { error: `Please wait ${cooldown.retryAfterSec} seconds before requesting another code.` };
  const rl = await rateLimit(`otp-resend:${pending.userId}`, 3, 10 * 60);
  if (!rl.allowed) return { error: "Too many resend requests. Please wait a few minutes." };
  const user = await User.findById(pending.userId).lean<IUser>();
  if (!user || !user.active) redirect("/login");
  try {
    await issueOtp(user, "login", pending._id); // invalidates every earlier code
  } catch (err) {
    console.error("[auth] Failed to resend OTP email:", toMailError(err).message);
    return { error: "We could not send the email. Please try again shortly." };
  }
  return { message: "A new code has been sent to your email." };
}

export async function logoutAction() {
  const u = await getSessionUser();
  if (u) await audit({ actor: u, action: "logout", entityType: "user", entityId: u.id, summary: "Signed out" });
  await destroyCurrentSession();
  redirect("/login");
}

/* ---------------- Password reset (email OTP) ---------------- */

export async function requestPasswordResetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = z.string().trim().toLowerCase().email().safeParse(formData.get("email"));
  if (!email.success) return { error: "Enter a valid email address." };
  const response: FormState = { step: "reset", email: email.data, message: RESET_REQUEST_MESSAGE };

  const [rl, ipl] = await Promise.all([rateLimit(`pwreset:${email.data}`, 3, 30 * 60), rateLimit(`pwreset:ip:${await clientIp()}`, 10, 30 * 60)]);
  // identical response — and identical work before responding — whether or not the account exists or we are rate limited
  if (!rl.allowed || !ipl.allowed) return response;

  await connectDb();
  const user = await User.findOne({ email: email.data, active: true });
  if (user) {
    await deferTask(async () => {
      await issueOtp(user, "password_reset");
      await audit({ action: "otp_sent", entityType: "user", entityId: user._id, summary: "Password reset OTP emailed" });
    });
  }
  return response;
}

const resetSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code."),
  password: z.string().max(256),
});

export async function resetPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = resetSchema.safeParse({
    email: formData.get("email"),
    code: formData.get("code"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { step: "reset", email: String(formData.get("email") ?? ""), error: parsed.error.issues[0].message };
  const { email, code, password } = parsed.data;
  const invalid: FormState = { step: "reset", email, error: "Invalid or expired code." };

  if (!password) return { step: "reset", email, error: "Enter a new password." };
  const rl = await rateLimit(`pwreset-verify:${email}`, 10, 30 * 60);
  if (!rl.allowed) return { step: "reset", email, error: "Too many attempts. Please wait and try again." };

  await connectDb();
  const user = await User.findOne({ email, active: true });
  if (!user) return invalid;

  // 1) Check the code WITHOUT consuming it, so a typo'd/weak password doesn't burn it — and so only someone who holds a
  //    valid code can ever see a policy error (otherwise the policy message would reveal which emails have accounts).
  const peek = await verifyOtp(user._id, "password_reset", code, { consume: false });
  if (peek !== "ok") return invalid;

  // The Super Admin may use any password; every other role must meet the password policy.
  if (user.role !== "super_admin") {
    const strength = checkPasswordStrength(password);
    if (!strength.ok) return { step: "reset", email, error: `Password must include ${strength.problems.join(", ")}.` };
  }

  // 2) Consume the code (single use, atomic) and only then change the password.
  const used = await verifyOtp(user._id, "password_reset", code);
  if (used !== "ok") return invalid;

  await User.updateOne(
    { _id: user._id },
    { $set: { passwordHash: await hashPassword(password), mustChangePassword: false, passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null } },
  );
  await destroyAllSessionsFor(user._id); // every device is signed out
  await audit({ actor: { id: user._id, role: user.role, email: user.email }, action: "password_change", entityType: "user", entityId: user._id, summary: "Password reset via email OTP" });
  redirect("/login?reset=1");
}

/* ---------------- Change password (signed in) ---------------- */

export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const u = await getSessionUser();
  if (!u) redirect("/login");
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("password") ?? "");
  if (!(await verifyPassword(current, u.doc.passwordHash))) return { error: "Current password is incorrect." };
  if (!next) return { error: "Enter a new password." };
  // The Super Admin may use any password; every other role must meet the password policy.
  if (u.role !== "super_admin") {
    const strength = checkPasswordStrength(next);
    if (!strength.ok) return { error: `Password must include ${strength.problems.join(", ")}.` };
  }
  if (current === next) return { error: "New password must be different from the current one." };
  await User.updateOne({ _id: u.id }, { $set: { passwordHash: await hashPassword(next), mustChangePassword: false, passwordChangedAt: new Date() } });
  await destroyOtherSessionsFor(u.id, u.sessionId); // other devices are signed out; this one stays
  await audit({ actor: u, action: "password_change", entityType: "user", entityId: u.id, summary: "Password changed (other sessions signed out)" });
  redirect("/dashboard");
}
