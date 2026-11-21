import { connectDb } from "@/lib/db/connect";
import { Payment, type IPayment } from "@/lib/db/models/payment";
import type { Provider } from "@/lib/db/models/integration-event";
import { decideWebhookTransition, type ProviderEvent } from "./webhook-decision";
import { parseAmountToMinor } from "./money";
import { normalizeText } from "./destination";
import { addCallbackEvidence } from "./receipts";
import { appendPaymentEvent, auditPayment, casTransition, raiseExceptionTask } from "./core";
import type { PaymentStatus } from "./rules";

export type ProviderOutcome =
  | { outcome: "applied"; paymentId: string; from: PaymentStatus; to: PaymentStatus }
  | { outcome: "noop"; paymentId: string; reason: string }
  | { outcome: "ignored"; paymentId: string; reason: string }
  | { outcome: "unknown_payment" };

/**
 * Applies ONE verified, de-duplicated provider (Ria/bank) event to the ledger. System actor (no user).
 * - matches by our payment UUID (idempotency key) or by the recorded provider reference
 * - only transitions allowed by the state machine are applied; anything else is kept for human review
 * - amount / beneficiary disagreements are flagged, never silently accepted
 * Safe to call twice for the same event: the compare-and-set + unique (paymentId, providerEventId) make it a no-op.
 */
export async function applyProviderEvent(provider: Provider, ev: ProviderEvent, rawBody: string): Promise<ProviderOutcome> {
  await connectDb();
  let p: IPayment | null = null;
  if (ev.idempotencyKey) p = await Payment.findById(ev.idempotencyKey).lean<IPayment>();
  if (!p && ev.transferId) p = await Payment.findOne({ providerName: provider, providerReference: ev.transferId }).lean<IPayment>();
  if (!p) return { outcome: "unknown_payment" };

  // a callback may only ever refer to the reference we recorded (or fill it in when still missing)
  if (ev.transferId && p.providerReference && p.providerReference !== ev.transferId) {
    await appendPaymentEvent({ paymentId: p._id, candidateId: p.candidateId, kind: "webhook", actorType: "webhook", providerEventId: ev.eventId, reason: "Callback reference does not match the recorded reference; ignored", meta: { ignored: true } }).catch(() => undefined);
    await raiseExceptionTask(p, "unmatched_callback", "Provider reference differs from the recorded reference");
    return { outcome: "ignored", paymentId: p._id, reason: "provider reference mismatch" };
  }

  const decision = decideWebhookTransition(p.status, ev.status, { hasProviderReference: !!(p.providerReference || ev.transferId) });

  const note = async (reason: string, meta: Record<string, unknown>) => {
    try {
      await appendPaymentEvent({ paymentId: p!._id, candidateId: p!.candidateId, kind: "webhook", actorType: "webhook", providerEventId: ev.eventId, reason, meta });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err; // already attached: duplicate delivery
    }
  };

  if (decision.action === "noop") {
    await note(decision.reason, { provider, providerStatus: ev.status, noop: true });
    return { outcome: "noop", paymentId: p._id, reason: decision.reason };
  }
  if (decision.action === "ignore") {
    await note(decision.reason, { provider, providerStatus: ev.status, ignored: true });
    await auditPayment(null, "webhook", p, `${provider} callback ignored: ${decision.reason}`, { source: "webhook" });
    await raiseExceptionTask(p, "unmatched_callback", decision.reason);
    return { outcome: "ignored", paymentId: p._id, reason: decision.reason };
  }

  // amount / beneficiary disagreement checks (never silently accept a "paid" that doesn't match the ledger)
  let mismatch: string | null = null;
  if (ev.amount !== undefined && ev.currency) {
    try {
      const minor = parseAmountToMinor(ev.amount, ev.currency);
      if (ev.currency.toUpperCase() !== p.currency || minor !== p.amountMinor) mismatch = "Callback amount/currency differs from the ledger";
    } catch {
      mismatch = "Callback amount could not be read";
    }
  }
  if (!mismatch && ev.beneficiaryName && p.recipientName && normalizeText(ev.beneficiaryName) !== normalizeText(p.recipientName)) {
    mismatch = "Callback beneficiary name differs from the recipient on the payment";
  }
  if (mismatch && decision.to === "paid") {
    await note(mismatch, { provider, providerStatus: ev.status, ignored: true, mismatch: true });
    await Payment.updateOne({ _id: p._id }, { $set: { beneficiaryMismatch: true, beneficiaryMismatchNote: mismatch } });
    await auditPayment(null, "webhook", p, `${provider} Paid callback held for review: ${mismatch}`, { source: "webhook" });
    await raiseExceptionTask(p, "mismatch", mismatch);
    return { outcome: "ignored", paymentId: p._id, reason: mismatch };
  }

  // the signed callback body is stored (encrypted) as evidence before the state changes
  const evidence = decision.to === "paid" || decision.to === "failed" || decision.to === "reversed" ? await addCallbackEvidence(p, rawBody, provider) : null;
  const when = ev.occurredAt ? new Date(ev.occurredAt) : new Date();
  const set: Record<string, unknown> = {};
  if (!p.providerReference && ev.transferId) set.providerReference = ev.transferId;
  if (decision.to === "paid") Object.assign(set, { paidAt: when, paidVia: "provider_callback" });
  if (decision.to === "failed") Object.assign(set, { failedAt: when, exceptionReason: ev.failureReason ?? "Provider reported a failure" });
  if (decision.to === "cancelled") Object.assign(set, { cancelledAt: when, exceptionReason: ev.failureReason ?? "Cancelled by provider" });
  if (decision.to === "reversed") Object.assign(set, { reversedAt: when, exceptionReason: ev.failureReason ?? "Returned by provider" });
  if (mismatch) Object.assign(set, { beneficiaryMismatch: true, beneficiaryMismatchNote: mismatch });

  // a concurrent change throws PaymentConflictError → the webhook is marked failed and re-evaluated on retry
  const updated: IPayment = await casTransition(p, decision.to, { set });
  await note(`${provider} callback: ${p.status} → ${decision.to}`, { provider, providerStatus: ev.status, receiptId: evidence?._id, mismatch: mismatch ?? undefined });
  // status change gets its own explicit timeline entry (reversal events are kind "reversal")
  await appendPaymentEvent({
    paymentId: p._id, candidateId: p.candidateId, kind: decision.to === "reversed" ? "reversal" : decision.to === "cancelled" ? "cancellation" : "status_change",
    actorType: "webhook", fromStatus: p.status, toStatus: decision.to, reason: `Verified ${provider} callback (${ev.status})`, meta: { providerEventId: ev.eventId },
  });
  await auditPayment(null, "webhook", updated, `${provider} callback applied: ${p.status} → ${decision.to}`, { source: "webhook", before: { status: p.status }, after: { status: decision.to } });
  if (decision.to === "failed") await raiseExceptionTask(updated, "failed", ev.failureReason);
  if (decision.to === "reversed") await raiseExceptionTask(updated, "reversed", ev.failureReason);
  if (decision.to === "paid") await raiseExceptionTask(updated, "reconcile", "Reconcile against the bank statement / provider report");
  if (mismatch) await raiseExceptionTask(updated, "mismatch", mismatch);
  return { outcome: "applied", paymentId: p._id, from: p.status, to: decision.to };
}
