import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** Derive purpose-specific 32-byte keys from APP_SECRET so one leaked key doesn't expose the others. */
export function deriveKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", env().APP_SECRET, "stem-opt-crm", purpose, 32));
}

export function hmacHex(purpose: string, data: string): string {
  return createHmac("sha256", deriveKey(purpose)).update(data).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
