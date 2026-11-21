import { makeSchema, makeAppendOnly, model } from "../base";

export interface IPayrollSyncLog {
  _id: string;
  provider: "gusto";
  batchId?: string | null;
  kind: "import" | "sync" | "webhook" | "reconcile" | "evidence" | "mapping";
  level: "info" | "warn" | "error";
  message: string;
  actorId?: string | null;
  source: "ui" | "api" | "webhook" | "system";
  eventId?: string | null;
  counts?: Record<string, number>;
  createdAt: Date;
}

const schema = makeSchema<IPayrollSyncLog>(
  {
    provider: { type: String, enum: ["gusto"], default: "gusto" },
    batchId: { type: String, default: null, index: true },
    kind: { type: String, enum: ["import", "sync", "webhook", "reconcile", "evidence", "mapping"], required: true },
    level: { type: String, enum: ["info", "warn", "error"], default: "info" },
    message: { type: String, required: true },
    actorId: { type: String, default: null },
    source: { type: String, enum: ["ui", "api", "webhook", "system"], default: "ui" },
    eventId: { type: String, default: null },
    counts: { type: Object },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ createdAt: -1 });
makeAppendOnly(schema); // every import / sync / error is a permanent log line

export const PayrollSyncLog = model<IPayrollSyncLog>("PayrollSyncLog", schema, "payroll_sync_logs");
