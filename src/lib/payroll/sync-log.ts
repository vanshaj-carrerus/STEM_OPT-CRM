import { connectDb } from "@/lib/db/connect";
import { PayrollSyncLog, type IPayrollSyncLog } from "@/lib/db/models/payroll-sync-log";

/** Append one line to `payroll_sync_logs` (every import / sync / webhook / reconciliation event and every error). */
export async function logSync(entry: {
  kind: IPayrollSyncLog["kind"];
  level?: IPayrollSyncLog["level"];
  message: string;
  batchId?: string | null;
  actorId?: string | null;
  source?: IPayrollSyncLog["source"];
  eventId?: string | null;
  counts?: Record<string, number>;
}) {
  await connectDb();
  await PayrollSyncLog.create({
    provider: "gusto",
    kind: entry.kind,
    level: entry.level ?? "info",
    message: entry.message.slice(0, 1000),
    batchId: entry.batchId ?? null,
    actorId: entry.actorId ?? null,
    source: entry.source ?? (entry.actorId ? "ui" : "system"),
    eventId: entry.eventId ?? null,
    counts: entry.counts,
  });
}
