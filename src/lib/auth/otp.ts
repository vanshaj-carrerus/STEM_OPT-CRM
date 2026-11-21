import { randomInt } from "node:crypto";
import { connectDb } from "@/lib/db/connect";
import { OtpChallenge } from "@/lib/db/models/otp";
import { hmacHex, safeEqualHex } from "@/lib/crypto/keys";
import { codeEmailHtml, sendMail } from "@/lib/mail";

export const OTP_TTL_MIN = 10;
export const OTP_MAX_ATTEMPTS = 5;

type Purpose = "login" | "password_reset" | "email_verify";

const hashCode = (userId: string, purpose: Purpose, code: string) => hmacHex("otp", `${userId}:${purpose}:${code}`);

export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

const SUBJECTS: Record<Purpose, string> = {
  login: "Your Compliance CRM sign-in code",
  password_reset: "Your Compliance CRM password reset code",
  email_verify: "Verify your Compliance CRM email",
};

/** Creates a challenge (invalidating older ones for the same purpose) and emails the code. */
export async function issueOtp(user: { _id: string; email: string; name: string }, purpose: Purpose, sessionId?: string) {
  await connectDb();
  await OtpChallenge.updateMany({ userId: user._id, purpose, consumed: false }, { $set: { consumed: true } });
  const code = generateOtpCode();
  await OtpChallenge.create({
    userId: user._id,
    purpose,
    codeHash: hashCode(user._id, purpose, code),
    expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60_000),
    sessionId: sessionId ?? null,
  });
  await sendMail({
    to: user.email,
    subject: SUBJECTS[purpose],
    html: codeEmailHtml({ title: SUBJECTS[purpose], name: user.name, code, minutes: OTP_TTL_MIN }),
    text:
      `Hello ${user.name},\n\nYour verification code is: ${code}\n\n` +
      `It expires in ${OTP_TTL_MIN} minutes. If you did not request this, ignore this email and contact your administrator.\n`,
  });
}

export type OtpResult = "ok" | "invalid" | "expired" | "too_many_attempts";

/**
 * Verify a code. Single use (consumed atomically), time-limited, at most OTP_MAX_ATTEMPTS guesses per code.
 * For login codes pass `sessionId`: the code is only valid for the sign-in attempt (OTP-stage session) that requested it.
 */
export async function verifyOtp(
  userId: string,
  purpose: Purpose,
  code: string,
  opts: { sessionId?: string; /** false = check only, leave the code usable (still counts as an attempt) */ consume?: boolean } = {},
): Promise<OtpResult> {
  await connectDb();
  const ch = await OtpChallenge.findOne({ userId, purpose, consumed: false, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }).sort({ createdAt: -1 });
  if (!ch || ch.expiresAt.getTime() < Date.now()) return "expired";
  if (ch.attempts >= OTP_MAX_ATTEMPTS) return "too_many_attempts";
  // count the attempt atomically before comparing so parallel guesses can't exceed the limit
  const upd = await OtpChallenge.findOneAndUpdate(
    { _id: ch._id, consumed: false, attempts: { $lt: OTP_MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  if (!upd) return "too_many_attempts";
  if (!/^\d{6}$/.test(code) || !safeEqualHex(hashCode(userId, purpose, code), ch.codeHash)) return "invalid";
  if (opts.consume === false) return "ok";
  const used = await OtpChallenge.updateOne({ _id: ch._id, consumed: false }, { $set: { consumed: true } });
  return used.modifiedCount === 1 ? "ok" : "invalid";
}
