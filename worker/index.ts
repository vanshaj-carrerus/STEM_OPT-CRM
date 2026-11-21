/**
 * Background worker: `npm run worker` (tsx worker/index.ts).
 * Runs the daily reminder / escalation job (and a safe hourly catch-up). The job is idempotent — reminders are
 * inserted against a UNIQUE key before sending — so overlapping runs, restarts or several workers never duplicate sends.
 */
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch {
  /* .env.local is optional when variables come from the environment */
}

async function main() {
  const cron = (await import("node-cron")).default;
  const { runDailyJob } = await import("../src/lib/reminders/runner");
  const { env } = await import("../src/lib/env");
  env(); // fail fast on bad configuration

  const log = (m: string) => console.log(`[worker ${new Date().toISOString()}] ${m}`);
  const tick = async (why: string) => {
    try {
      log(`run (${why})`);
      await runDailyJob({ log });
    } catch (e) {
      // never crash the process: the next tick retries
      console.error(`[worker] ${why} run failed:`, e);
    }
  };

  const tz = process.env.WORKER_TIMEZONE || "America/New_York";
  cron.schedule("0 6 * * *", () => void tick("daily 06:00"), { timezone: tz });
  cron.schedule("30 * * * *", () => void tick("hourly catch-up"), { timezone: tz });
  log(`scheduled: daily 06:00 and hourly :30 (${tz})`);
  await tick("startup");

  const stop = () => {
    log("shutting down");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
