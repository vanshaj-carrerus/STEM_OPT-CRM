import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { requestCookies as cookies, requestHeaders as headers } from "@/lib/request-context";
import { connectDb } from "@/lib/db/connect";
import { Session } from "@/lib/db/models/session";
import { User, type IUser } from "@/lib/db/models/user";
import type { Actor } from "@/lib/rbac/can";

export const SESSION_COOKIE = "crm_session";
const OTP_STAGE_MIN = 10;
const ABSOLUTE_HOURS = 12;
const IDLE_MIN = 30;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createSession(userId: string, stage: "otp" | "active") {
  await connectDb();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const h = await headers();
  const expiresAt = new Date(now + (stage === "otp" ? OTP_STAGE_MIN * 60_000 : ABSOLUTE_HOURS * 3600_000));
  const idleExpiresAt = new Date(now + (stage === "otp" ? OTP_STAGE_MIN : IDLE_MIN) * 60_000);
  const doc = await Session.create({
    userId,
    tokenHash: sha256(token),
    stage,
    expiresAt,
    idleExpiresAt,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: h.get("user-agent") ?? undefined,
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return doc;
}

/** Upgrade an OTP-stage session to a fully authenticated one (rotating the token to prevent fixation). */
export async function promoteSession(sessionId: string, userId: string) {
  await connectDb();
  await Session.deleteOne({ _id: sessionId });
  return createSession(userId, "active");
}

async function currentSessionRow(stage: "otp" | "active") {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  await connectDb();
  const now = new Date();
  const s = await Session.findOne({
    tokenHash: sha256(token),
    stage,
    expiresAt: { $gt: now },
    idleExpiresAt: { $gt: now },
  });
  return s;
}

export async function getPendingOtpSession() {
  return currentSessionRow("otp");
}

export interface SessionUser extends Actor {
  email: string;
  name: string;
  timezone: string;
  mustChangePassword: boolean;
  sessionId: string;
  doc: IUser;
}

/** Resolve the logged-in user for this request (null when not authenticated). Cached per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const s = await currentSessionRow("active");
  if (!s) return null;
  const user = await User.findById(s.userId).lean<IUser>();
  if (!user || !user.active) return null;
  // sliding idle expiry (throttled to once a minute to avoid a write on every request)
  if (s.idleExpiresAt.getTime() - Date.now() < (IDLE_MIN - 1) * 60_000) {
    await Session.updateOne({ _id: s._id }, { $set: { idleExpiresAt: new Date(Date.now() + IDLE_MIN * 60_000) } });
  }
  return {
    id: user._id,
    role: user.role,
    extraPermissions: user.extraPermissions,
    deniedPermissions: user.deniedPermissions,
    teamIds: user.teamIds,
    email: user.email,
    name: user.name,
    timezone: user.timezone,
    mustChangePassword: user.mustChangePassword,
    sessionId: s._id,
    doc: user,
  };
});

export async function destroyCurrentSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await connectDb();
    await Session.deleteOne({ tokenHash: sha256(token) });
  }
  jar.delete(SESSION_COOKIE);
}

export async function destroyAllSessionsFor(userId: string) {
  await connectDb();
  await Session.deleteMany({ userId });
}

/** Sign a user out everywhere EXCEPT the session making the request (e.g. after they change their own password). */
export async function destroyOtherSessionsFor(userId: string, keepSessionId: string) {
  await connectDb();
  await Session.deleteMany({ userId, _id: { $ne: keepSessionId } });
}
