import { canTransitionPayroll, type PayrollStatus } from "./rules";

/**
 * Pure webhook decision logic for Gusto payroll events (AC-13).
 * No I/O here: the route verifies the signature + records the event, then asks these functions what to do.
 *
 * NOTE: Gusto's App Integrations API is restricted to approved partners, so the exact payload is unconfirmed.
 * The parser is deliberately tolerant (several field spellings) and the endpoint stays disabled until
 * GUSTO_WEBHOOK_SECRET is configured.
 */
export interface GustoWebhookEvent {
  eventId: string;
  eventType: string;
  externalRef: string;
  occurredAt: Date | null;
  /** The CRM payroll status this event implies, or null if the event type does not map to one. */
  target: PayrollStatus | null;
}

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

export function mapEventTypeToStatus(eventType: string): PayrollStatus | null {
  const t = eventType.toLowerCase();
  if (/(cancel|void)/.test(t)) return "voided";
  if (/(fail|error|reject)/.test(t)) return "failed";
  if (/(processed|paid|completed|complete)/.test(t)) return "processed";
  if (/(submitted|processing|calculated_and_submitted)/.test(t)) return "processing";
  return null;
}

export function parseGustoWebhook(payload: unknown): { ok: true; event: GustoWebhookEvent } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") return { ok: false, error: "Payload must be a JSON object." };
  const p = payload as Rec;
  const data = (p.data && typeof p.data === "object" ? (p.data as Rec) : {}) as Rec;
  const resource = (p.resource && typeof p.resource === "object" ? (p.resource as Rec) : {}) as Rec;

  const eventId = str(p.event_id) ?? str(p.eventId) ?? str(p.uuid) ?? str(p.id);
  const eventType = str(p.event_type) ?? str(p.eventType) ?? str(p.type);
  const externalRef =
    str(p.resource_uuid) ?? str(p.entity_uuid) ?? str(p.payroll_uuid) ?? str(p.payroll_id) ??
    str(data.payroll_uuid) ?? str(data.payroll_id) ?? str(resource.uuid) ?? str(resource.id);

  if (!eventId) return { ok: false, error: "Missing event id." };
  if (!eventType) return { ok: false, error: "Missing event type." };
  if (!externalRef) return { ok: false, error: "Missing payroll reference." };
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(eventId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(externalRef)) return { ok: false, error: "Malformed identifiers." };

  const ts = str(p.timestamp) ?? str(p.occurred_at) ?? str(p.created_at);
  let occurredAt: Date | null = null;
  if (ts) {
    const n = /^\d{9,13}$/.test(ts) ? (ts.length > 10 ? Number(ts) : Number(ts) * 1000) : Date.parse(ts);
    if (Number.isFinite(n)) occurredAt = new Date(n);
  }
  return { ok: true, event: { eventId, eventType: eventType.slice(0, 80), externalRef, occurredAt, target: mapEventTypeToStatus(eventType) } };
}

export type TransitionPlan =
  | { action: "noop"; reason: string }
  | { action: "apply"; steps: PayrollStatus[] }
  | { action: "reject"; reason: string };

/**
 * Which state changes may a (verified) provider event apply? ONLY ones `canTransitionPayroll` allows.
 * A provider "processed" for an approved batch that never recorded "processing" is applied as two valid steps.
 * Anything touching an unapproved batch is rejected (it needs human attention, never silently applied).
 */
export function planWebhookTransitions(current: PayrollStatus, target: PayrollStatus | null): TransitionPlan {
  if (!target) return { action: "noop", reason: "Event type does not change payroll status." };
  if (current === target) return { action: "noop", reason: "Batch is already in this state." };
  if (canTransitionPayroll(current, target)) return { action: "apply", steps: [target] };
  if (target === "processed" && current === "approved") return { action: "apply", steps: ["processing", "processed"] };
  if (current === "processed" || current === "voided") return { action: "reject", reason: `Batch is ${current}; the provider event cannot change it (use a linked adjustment).` };
  return { action: "reject", reason: `Provider reported ${target} but the batch is ${current} in the CRM (approval workflow not completed).` };
}

export type DeliveryDecision = "process" | "retry" | "ignore";

/** A "received" event untouched for this long is assumed to belong to a crashed worker and may be retried. */
export const STALE_RECEIVED_MS = 5 * 60_000;

/**
 * Duplicate-delivery rule. A brand-new event is processed; a redelivery of an event that previously FAILED (or was
 * abandoned in-flight for > 5 min) is retried; everything else (processed / in-flight duplicates) is acknowledged
 * with 200 and NOT applied again. Applying is itself guarded by canTransitionPayroll + optimistic concurrency.
 */
export function decideDelivery(isNew: boolean, existingStatus: string | undefined, receivedAgeMs = 0): DeliveryDecision {
  if (isNew) return "process";
  if (existingStatus === "failed") return "retry";
  if (existingStatus === "received" && receivedAgeMs > STALE_RECEIVED_MS) return "retry";
  return "ignore";
}
