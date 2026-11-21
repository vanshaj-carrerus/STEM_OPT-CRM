import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api";
import { rateLimit } from "@/lib/auth/ratelimit";
import { env } from "@/lib/env";
import { bearerMatches } from "@/lib/reminders/cron-auth";
import { runDailyJob } from "@/lib/reminders/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/cron/tick — for serverless schedulers. Authorised ONLY by `Authorization: Bearer $CRON_SECRET`
 * (disabled when CRON_SECRET is unset). Rate-limited; the job itself is idempotent so extra ticks are harmless.
 */
export async function POST(req: NextRequest) {
  const secret = env().CRON_SECRET;
  if (!secret) return apiError(404, "Not found");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await rateLimit(`cron:${ip}`, 12, 60);
  if (!rl.allowed) return apiError(429, "Rate limit exceeded", { retryAfterSec: rl.retryAfterSec });
  if (!bearerMatches(req.headers.get("authorization"), secret)) return apiError(401, "Unauthorized");
  const summary = await runDailyJob({
    revalidate: (paths) => paths.forEach((p) => revalidatePath(p)),
  });
  return NextResponse.json({ ok: true, summary });
}
