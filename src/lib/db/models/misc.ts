import { makeSchema, model } from "../base";

/** Sliding-window rate limit counters (TTL cleaned). */
export interface IRateLimit {
  _id: string; // key e.g. "login:ip:1.2.3.4"
  count: number;
  expiresAt: Date;
}
const rl = makeSchema<IRateLimit>({
  _id: { type: String },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});
rl.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RateLimit = model<IRateLimit>("RateLimit", rl, "rate_limits");

/** Key/value settings (reminder offsets, templates, retention policy, integration flags...). */
export interface ISetting {
  _id: string; // setting key
  value: unknown;
  updatedBy?: string | null;
  updatedAt: Date;
}
const st = makeSchema<ISetting>({
  _id: { type: String },
  value: { type: Object },
  updatedBy: { type: String, default: null },
});
export const Setting = model<ISetting>("Setting", st, "settings");
