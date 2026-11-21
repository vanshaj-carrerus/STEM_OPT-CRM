import { makeSchema, model } from "../base";

/** Emailed one-time code. Used for login second factor and password reset. Only the HMAC of the code is stored. */
export interface IOtpChallenge {
  _id: string;
  userId: string;
  purpose: "login" | "password_reset" | "email_verify";
  codeHash: string;
  attempts: number;
  consumed: boolean;
  expiresAt: Date;
  sessionId?: string | null;
  createdAt: Date;
}

const schema = makeSchema<IOtpChallenge>({
  userId: { type: String, required: true, index: true },
  purpose: { type: String, enum: ["login", "password_reset", "email_verify"], required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  consumed: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
  sessionId: { type: String, default: null },
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpChallenge = model<IOtpChallenge>("OtpChallenge", schema, "otp_challenges");
