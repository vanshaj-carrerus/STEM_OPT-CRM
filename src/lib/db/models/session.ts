import { makeSchema, model } from "../base";

/**
 * A session row exists in two phases:
 *  - `stage: "otp"`  : password verified, waiting for emailed OTP (short-lived, cannot access the app)
 *  - `stage: "active"`: fully authenticated
 * The cookie holds a random token; only its SHA-256 hash is stored.
 */
export interface ISession {
  _id: string;
  userId: string;
  tokenHash: string;
  stage: "otp" | "active";
  expiresAt: Date; // absolute expiry (TTL index deletes the row afterwards)
  idleExpiresAt: Date;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

const schema = makeSchema<ISession>({
  userId: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  stage: { type: String, enum: ["otp", "active"], required: true },
  expiresAt: { type: Date, required: true },
  idleExpiresAt: { type: Date, required: true },
  ip: String,
  userAgent: String,
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model<ISession>("Session", schema, "sessions");
