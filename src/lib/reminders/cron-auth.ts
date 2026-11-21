import { createHash, timingSafeEqual } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time `Authorization: Bearer <secret>` check (both sides hashed so lengths never leak). */
export function bearerMatches(header: string | null | undefined, secret: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const equal = timingSafeEqual(sha(presented), sha(secret));
  return equal && presented.length > 0;
}
