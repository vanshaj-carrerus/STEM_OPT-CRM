import { headers } from "next/headers";
import { connectDb } from "@/lib/db/connect";
import { AuditEvent, type AuditAction } from "@/lib/db/models/audit";
import type { Actor } from "@/lib/rbac/can";

export interface AuditInput {
  actor?: (Actor & { email?: string }) | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  candidateId?: string | null;
  summary?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  source?: "ui" | "api" | "worker" | "webhook" | "system";
}

/** Fields never written to the audit log in clear text. */
const REDACT = /(password|hash|secret|token|otp)$|^(enc|code)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

async function requestMeta() {
  try {
    const h = await headers();
    return {
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? undefined,
      userAgent: h.get("user-agent") ?? undefined,
      correlationId: h.get("x-correlation-id") ?? undefined,
    };
  } catch {
    return {}; // called outside a request (worker, tests)
  }
}

/** Write one immutable audit event. Never throws into the caller's business flow for read-logging failures. */
export async function audit(input: AuditInput): Promise<void> {
  await connectDb();
  const meta = await requestMeta();
  await AuditEvent.create({
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    actorRole: input.actor?.role ?? null,
    source: input.source ?? (input.actor ? "ui" : "system"),
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    candidateId: input.candidateId ?? null,
    action: input.action,
    summary: input.summary,
    reason: input.reason,
    before: redact(input.before),
    after: redact(input.after),
    ...meta,
  });
}

/** Shallow diff helper: returns only the fields that changed (for before/after logging). */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}
