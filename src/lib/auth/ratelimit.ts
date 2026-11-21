import { connectDb } from "@/lib/db/connect";
import { RateLimit } from "@/lib/db/models/misc";

export interface RateResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Fixed-window counter in Mongo (shared across server instances).
 *
 * The increment is ONE atomic upsert with an aggregation-pipeline update: if the current window is still open the
 * counter is incremented, otherwise a fresh window starts at 1. Because there is no read-then-write gap, a burst of
 * parallel requests can never slip past the limit (the old two-step version let every request in a burst at the start
 * of a window through).
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateResult> {
  await connectDb();
  const now = new Date();
  const fresh = new Date(now.getTime() + windowSec * 1000);

  const run = () =>
    RateLimit.findOneAndUpdate(
      { _id: key },
      [
        {
          $set: {
            count: { $cond: [{ $gt: ["$expiresAt", now] }, { $add: [{ $ifNull: ["$count", 0] }, 1] }, 1] },
            expiresAt: { $cond: [{ $gt: ["$expiresAt", now] }, "$expiresAt", fresh] },
          },
        },
      ],
      { upsert: true, returnDocument: "after", updatePipeline: true },
    ).lean();

  let doc;
  try {
    doc = await run();
  } catch (err) {
    // two parallel FIRST hits can race on the insert; the loser retries and increments the winner's document
    if ((err as { code?: number }).code !== 11000) throw err;
    doc = await run();
  }
  const count = doc?.count ?? 1;
  const expires = doc?.expiresAt ?? fresh;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSec: Math.max(1, Math.ceil((expires.getTime() - now.getTime()) / 1000)),
  };
}
