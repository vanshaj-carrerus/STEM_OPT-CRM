import { env } from "@/lib/env";
import { connectDb } from "@/lib/db/connect";
import { IntegrationEvent, type IIntegrationEvent } from "@/lib/db/models/integration-event";
import { PayrollBatch, type IPayrollBatch } from "@/lib/db/models/payroll-batch";
import { markFailed, markProcessed, recordEvent, verifySignature } from "@/lib/integrations/events";
import { todayIn } from "@/lib/compliance/dates";
import { upsertSystemTask } from "@/lib/tasks/core";
import { applyTransition } from "./batches";
import { decideDelivery, parseGustoWebhook, planWebhookTransitions, STALE_RECEIVED_MS } from "./webhook-map";
import type { PayrollStatus } from "./rules";
import { logSync } from "./sync-log";

/**
 * Gusto webhook processing (AC-13). Order matters:
 *   verify signature + replay window → parse → recordEvent (unique index) → decide → apply guarded transitions.
 * A duplicate/retried callback can never create or modify a second record: the unique (provider,eventId) index makes
 * the event a no-op, and the batch update itself is guarded by canTransitionPayroll + optimistic concurrency.
 */
export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

function stepFields(step: PayrollStatus, eventId: string, eventType: string, occurredAt: Date | null): Record<string, unknown> {
  switch (step) {
    case "processing":
      return { submittedToProviderAt: occurredAt ?? new Date() };
    case "processed":
      return {
        processedAt: occurredAt ?? new Date(),
        processedVia: "webhook",
        processedBy: null,
        providerEventId: eventId,
        reconciliation: { status: "pending" }, // Completed-Pending-Reconciliation until reconciled
      };
    case "failed":
      return { failureReason: `Provider event: ${eventType}`, providerEventId: eventId };
    case "voided":
      return { voidedReason: `Provider event: ${eventType}`, voidedAt: occurredAt ?? new Date(), providerEventId: eventId };
    default:
      return {};
  }
}

export async function handleGustoWebhook(rawBody: string, h: { signature: string | null; timestamp: string | null }): Promise<WebhookResult> {
  const secret = env().GUSTO_WEBHOOK_SECRET;
  if (!secret) return { status: 503, body: { error: "Gusto webhook is not configured." } };

  const sig = verifySignature({ secret, rawBody, signatureHeader: h.signature, timestampHeader: h.timestamp });
  if (!sig.ok) return { status: 401, body: { error: "Invalid signature", reason: sig.reason } };

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "Body must be JSON." } };
  }
  const parsed = parseGustoWebhook(payload);
  if (!parsed.ok) {
    await logSync({ kind: "webhook", level: "error", message: `Rejected webhook payload: ${parsed.error}`, source: "webhook" });
    return { status: 400, body: { error: parsed.error } };
  }
  const ev = parsed.event;

  await connectDb();
  const rec = await recordEvent({ provider: "gusto", eventId: ev.eventId, payload: rawBody });
  const existing = rec.event;
  const decision = decideDelivery(rec.isNew, existing.status, Date.now() - new Date(existing.receivedAt).getTime());
  if (decision === "ignore") return { status: 200, body: { received: true, duplicate: true } };

  if (decision === "retry") {
    // claim the retry atomically so two concurrent redeliveries cannot both re-apply
    const claimed = await IntegrationEvent.findOneAndUpdate(
      {
        _id: existing._id,
        status: existing.status,
        ...(existing.status === "received" ? { receivedAt: { $lte: new Date(Date.now() - STALE_RECEIVED_MS) } } : {}),
      },
      { $set: { status: "received", receivedAt: new Date() }, $unset: { error: "" } },
      { returnDocument: "after" },
    ).lean<IIntegrationEvent>();
    if (!claimed) return { status: 200, body: { received: true, duplicate: true } };
  }

  try {
    const batch = await PayrollBatch.findOne({ provider: "gusto", externalRef: ev.externalRef }).lean<IPayrollBatch>();
    if (!batch) {
      await logSync({ kind: "webhook", level: "warn", message: `Event ${ev.eventType} for Gusto payroll ${ev.externalRef}: no matching batch in the CRM (ignored)`, source: "webhook", eventId: ev.eventId });
      await markProcessed(existing._id);
      return { status: 200, body: { received: true, applied: false, reason: "no_matching_batch" } };
    }
    const plan = planWebhookTransitions(batch.status, ev.target);
    if (plan.action === "noop") {
      await markProcessed(existing._id);
      return { status: 200, body: { received: true, applied: false, reason: plan.reason } };
    }
    if (plan.action === "reject") {
      // a provider state the CRM workflow does not allow: never apply silently — raise it for a human
      await upsertSystemTask({
        candidateId: null, kind: "payroll", category: "payroll",
        refKey: `payroll:webhook:${ev.eventId}`,
        title: `Provider event does not match payroll workflow (${ev.eventType})`,
        description: plan.reason,
        dueDate: todayIn("UTC"), ownerId: batch.preparedBy, priority: "high", meta: { batchId: batch._id, eventId: ev.eventId },
      });
      await logSync({ kind: "webhook", level: "warn", message: `Event ${ev.eventType} not applied: ${plan.reason}`, batchId: batch._id, source: "webhook", eventId: ev.eventId });
      await markProcessed(existing._id);
      return { status: 200, body: { received: true, applied: false, reason: plan.reason } };
    }

    for (const step of plan.steps) {
      await applyTransition(batch._id, step, {
        actor: null,
        source: "webhook",
        set: stepFields(step, ev.eventId, ev.eventType, ev.occurredAt),
        summary: `Gusto provider event ${ev.eventType} → ${step} (event ${ev.eventId})`,
      });
    }
    await logSync({ kind: "webhook", message: `Applied ${ev.eventType} → ${plan.steps.join(" → ")}`, batchId: batch._id, source: "webhook", eventId: ev.eventId });
    await markProcessed(existing._id);
    return { status: 200, body: { received: true, applied: true, status: plan.steps[plan.steps.length - 1] } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    await markFailed(existing._id, msg);
    await logSync({ kind: "webhook", level: "error", message: `Webhook processing failed (will be retried): ${msg}`, source: "webhook", eventId: ev.eventId });
    return { status: 500, body: { error: "Processing failed; retry later." } };
  }
}
