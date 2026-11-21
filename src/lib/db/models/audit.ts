import { makeSchema, makeAppendOnly, model } from "../base";

export const AUDIT_ACTIONS = [
  "create",
  "read",
  "update",
  "delete",
  "download",
  "export",
  "approve",
  "reject",
  "status_change",
  "login",
  "login_failed",
  "logout",
  "otp_sent",
  "password_change",
  "reveal_sensitive",
  "permission_change",
  "import",
  "webhook",
  "system",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface IAuditEvent {
  _id: string;
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  source: "ui" | "api" | "worker" | "webhook" | "system";
  entityType: string;
  entityId?: string | null;
  candidateId?: string | null; // lets us show per-candidate activity/audit tab
  action: AuditAction;
  summary?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
  createdAt: Date;
}

const schema = makeSchema<IAuditEvent>(
  {
    actorId: { type: String, index: true },
    actorEmail: String,
    actorRole: String,
    source: { type: String, enum: ["ui", "api", "worker", "webhook", "system"], default: "ui" },
    entityType: { type: String, required: true, index: true },
    entityId: { type: String, index: true },
    candidateId: { type: String, index: true },
    action: { type: String, enum: AUDIT_ACTIONS, required: true, index: true },
    summary: String,
    reason: String,
    before: { type: Object },
    after: { type: Object },
    ip: String,
    userAgent: String,
    correlationId: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);
schema.index({ createdAt: -1 });
makeAppendOnly(schema);

export const AuditEvent = model<IAuditEvent>("AuditEvent", schema, "audit_events");
