import { connectDb } from "@/lib/db/connect";
import { Payment, type IPayment } from "@/lib/db/models/payment";
import { PaymentReceipt } from "@/lib/db/models/payment-receipt";
import type { SessionUser } from "@/lib/auth/session";
import { assertCan, can, ForbiddenError } from "@/lib/rbac/can";
import { assertReconciler } from "@/lib/sod";
import { evidenceRequirementText, evidenceSatisfied } from "./evidence";
import { validateProviderReference } from "./destination";
import { PaymentConflictError, PaymentError } from "./errors";
import { validateLinkedEvent, type MoneyEventKind } from "./linked";
import { formatMinor, parseAmountToMinor, parseSignedAmountToMinor, MoneyError } from "./money";
import { requesterIds, isDuplicateKey } from "./service";
import { appendPaymentEvent, auditPayment, casTransition, clearExceptionTasks, loadPaymentFor, raiseExceptionTask } from "./core";

const needReason = (reason: string, label = "A reason") => {
  if ((reason ?? "").trim().length < 5) throw new PaymentError(`${label} is required (at least 5 characters).`, 422, "validation", { reason: "Enter a reason" });
};

/* ------------------- Approved → Submitted (reference recorded) ------------------- */

/**
 * The operator initiates the transfer OUTSIDE the CRM (Ria / the bank's approved channel) and records the reference
 * here. The CRM never moves money itself unless `riaAutomationAllowed` (see automation.ts).
 */
export async function recordSubmission(actor: SessionUser, id: string, input: { providerReference: string; note?: string }) {
  assertCan(actor, "payments.submit");
  const p = await loadPaymentFor(actor, id);
  if (p.status !== "approved") throw new PaymentError("Only an Approved payment can be marked as submitted.", 409, "illegal_transition");
  const ref = validateProviderReference(input.providerReference);
  if (!ref.ok) throw new PaymentError(ref.error!, 422, "validation", { providerReference: ref.error! });

  try {
    const updated = await casTransition(p, "submitted", {
      set: { providerReference: ref.value, submittedBy: actor.id, submittedAt: new Date() },
    });
    await appendPaymentEvent({
      paymentId: id, candidateId: p.candidateId, kind: "status_change", actorId: actor.id,
      fromStatus: "approved", toStatus: "submitted", reason: input.note || "Transfer initiated outside the CRM; reference recorded",
      meta: { providerName: updated.providerName, providerReference: ref.value },
    });
    await auditPayment(actor, "status_change", updated, `Submitted — reference ${ref.value} recorded`, { before: { status: "approved" }, after: { status: "submitted", providerReference: ref.value } });
    return updated;
  } catch (err) {
    if (isDuplicateKey(err, "providerReference")) {
      throw new PaymentError("That provider/bank reference is already recorded on another payment (possible duplicate transfer).", 409, "duplicate_reference", { providerReference: "Already used on another payment" });
    }
    throw err;
  }
}

export async function markProcessing(actor: SessionUser, id: string, note?: string) {
  assertCan(actor, "payments.submit");
  const p = await loadPaymentFor(actor, id);
  const updated = await casTransition(p, "processing");
  await appendPaymentEvent({ paymentId: id, candidateId: p.candidateId, kind: "status_change", actorId: actor.id, fromStatus: p.status, toStatus: "processing", reason: note || "Provider reports the transfer is in progress" });
  await auditPayment(actor, "status_change", updated, "Marked Processing", { before: { status: p.status }, after: { status: "processing" } });
  return updated;
}

/* -------------------------------- Paid -------------------------------- */

/** Browser-submitted "paid" is accepted ONLY with a provider reference and evidence on file (receipt / confirmation). */
export async function markPaid(actor: SessionUser, id: string, input: { note?: string; paidAt?: string } = {}) {
  assertCan(actor, "payments.submit");
  const p = await loadPaymentFor(actor, id);
  if (!["submitted", "processing"].includes(p.status)) throw new PaymentError("Only a Submitted or Processing payment can be marked Paid.", 409, "illegal_transition");
  if (!p.providerReference) throw new PaymentError("Record the provider/bank reference before marking a payment as Paid.", 422, "missing_reference");
  const kinds = (await PaymentReceipt.find({ paymentId: id }).select("kind").lean<{ kind: string }[]>()).map((r) => r.kind);
  if (!evidenceSatisfied(p.type, kinds)) throw new PaymentError(evidenceRequirementText(p.type), 422, "missing_evidence");

  let paidAt = new Date();
  if (input.paidAt) {
    const t = new Date(input.paidAt);
    if (Number.isNaN(t.getTime()) || t.getTime() > Date.now() + 5 * 60_000) throw new PaymentError("Paid date cannot be in the future.", 422, "validation", { paidAt: "Invalid date" });
    paidAt = t;
  }
  const updated = await casTransition(p, "paid", { set: { paidAt, paidVia: "manual_evidence" } });
  await appendPaymentEvent({ paymentId: id, candidateId: p.candidateId, kind: "status_change", actorId: actor.id, fromStatus: p.status, toStatus: "paid", reason: input.note || "Marked Paid with evidence on file", meta: { evidence: kinds, providerReference: p.providerReference } });
  await auditPayment(actor, "status_change", updated, "Marked Paid (evidence on file)", { before: { status: p.status }, after: { status: "paid" } });
  await raiseExceptionTask(updated, "reconcile", "Reconcile against the bank statement / provider report");
  return updated;
}

/* ------------------------------ Failed / Reversed ------------------------------ */

export async function markFailed(actor: SessionUser, id: string, reason: string) {
  assertCan(actor, "payments.submit");
  needReason(reason, "A failure reason");
  const p = await loadPaymentFor(actor, id);
  const updated = await casTransition(p, "failed", { set: { failedAt: new Date(), exceptionReason: reason } });
  await appendPaymentEvent({ paymentId: id, candidateId: p.candidateId, kind: "status_change", actorId: actor.id, fromStatus: p.status, toStatus: "failed", reason });
  await auditPayment(actor, "status_change", updated, "Marked Failed", { reason, before: { status: p.status }, after: { status: "failed" } });
  await raiseExceptionTask(updated, "failed", reason);
  return updated;
}

/** Full return/reversal (a linked event; the original row is kept and flagged). */
export async function reversePayment(actor: SessionUser, id: string, reason: string) {
  needReason(reason, "A reversal reason");
  const p = await loadPaymentFor(actor, id);
  const allowed = p.status === "reconciled" ? can(actor, "payments.reconcile") : can(actor, "payments.submit") || can(actor, "payments.reconcile");
  if (!allowed) throw new ForbiddenError();
  const updated = await casTransition(p, "reversed", { set: { reversedAt: new Date(), exceptionReason: reason } });
  await appendPaymentEvent({ paymentId: id, candidateId: p.candidateId, kind: "reversal", actorId: actor.id, fromStatus: p.status, toStatus: "reversed", reason, currency: p.currency });
  await auditPayment(actor, "status_change", updated, "Payment reversed / returned", { reason, before: { status: p.status }, after: { status: "reversed" } });
  await clearExceptionTasks(updated, ["reconcile"], "Payment reversed");
  await raiseExceptionTask(updated, "reversed", reason);
  return updated;
}

/* -------------------- partial / return / correction (linked) -------------------- */

export async function recordLinkedEvent(actor: SessionUser, id: string, input: { kind: MoneyEventKind; amount: string; reason: string; providerReference?: string }) {
  needReason(input.reason);
  const p = await loadPaymentFor(actor, id);
  if (!["paid", "reconciled"].includes(p.status)) throw new PaymentError("Partial payments, returns and corrections are recorded against a Paid or Reconciled payment.", 409, "illegal_state");

  if (input.kind === "correction") {
    if (!can(actor, "payments.reconcile")) throw new ForbiddenError("Corrections require a finance approver (payments.reconcile).");
    assertReconciler(actor.id, p.requestedBy ?? p.createdBy, [...p.approvedBy, ...requesterIds(p)], p.highRisk);
  } else if (!can(actor, "payments.submit") && !can(actor, "payments.reconcile")) throw new ForbiddenError();

  let inputMinor: number;
  try {
    inputMinor = input.kind === "correction" ? parseSignedAmountToMinor(input.amount, p.currency) : parseAmountToMinor(input.amount, p.currency);
  } catch (e) {
    throw new PaymentError((e as MoneyError).message, 422, "validation", { amount: (e as MoneyError).message });
  }
  const net = p.amountMinor + p.adjustmentMinor;
  const chk = validateLinkedEvent(input.kind, net, inputMinor);
  if (!chk.ok) throw new PaymentError(chk.error, 422, "validation", { amount: chk.error });

  await connectDb();
  // compare-and-set on the adjustment counter so concurrent events can't over-adjust
  const updated = await Payment.findOneAndUpdate(
    { _id: id, status: p.status, adjustmentMinor: p.adjustmentMinor },
    { $inc: { adjustmentMinor: chk.deltaMinor } },
    { returnDocument: "after" },
  ).lean<IPayment>();
  if (!updated) throw new PaymentConflictError();
  try {
    await appendPaymentEvent({
      paymentId: id, candidateId: p.candidateId, kind: input.kind, actorId: actor.id,
      reason: input.reason, amountDeltaMinor: chk.deltaMinor, currency: p.currency,
      meta: { netBeforeMinor: net, netAfterMinor: net + chk.deltaMinor, providerReference: input.providerReference },
    });
  } catch (err) {
    await Payment.updateOne({ _id: id }, { $inc: { adjustmentMinor: -chk.deltaMinor } }); // roll back the counter
    throw err;
  }
  await auditPayment(actor, "update", updated, `Linked ${input.kind} event recorded`, { reason: input.reason, before: { netMinor: net }, after: { netMinor: net + chk.deltaMinor, deltaMinor: chk.deltaMinor } });
  if (input.kind !== "correction") await raiseExceptionTask(updated, "returned", `${input.kind} of ${Math.abs(chk.deltaMinor)} minor units — ${input.reason}`);
  return updated;
}

/* ------------------------------- beneficiary mismatch ------------------------------- */

export async function flagBeneficiaryMismatch(actor: SessionUser, id: string, note: string) {
  if (!can(actor, "payments.submit") && !can(actor, "payments.approve") && !can(actor, "payments.reconcile")) throw new ForbiddenError();
  needReason(note, "A note describing the mismatch");
  const p = await loadPaymentFor(actor, id);
  if (["cancelled"].includes(p.status)) throw new PaymentError("A cancelled payment cannot be flagged.", 409, "illegal_state");
  const updated = await Payment.findOneAndUpdate({ _id: id, status: p.status }, { $set: { beneficiaryMismatch: true, beneficiaryMismatchNote: note } }, { returnDocument: "after" }).lean<IPayment>();
  if (!updated) throw new PaymentConflictError();
  await appendPaymentEvent({ paymentId: id, candidateId: p.candidateId, kind: "flag", actorId: actor.id, reason: note, meta: { flag: "beneficiary_mismatch" } });
  await auditPayment(actor, "update", updated, "Flagged beneficiary details mismatch", { reason: note });
  await raiseExceptionTask(updated, "mismatch", note);
  return updated;
}

/* -------------------------------- reconciliation -------------------------------- */

export async function reconcilePayment(
  actor: SessionUser,
  id: string,
  input: { statementRef: string; settledAmount: string; statementDate?: string; note?: string; mismatchResolution?: string },
) {
  assertCan(actor, "payments.reconcile");
  const p = await loadPaymentFor(actor, id);
  if (p.status !== "paid") throw new PaymentError("Only a Paid payment can be reconciled.", 409, "illegal_transition");

  // high-risk: reconciler must differ from the requester, the creator and every approver
  assertReconciler(actor.id, p.requestedBy ?? p.createdBy, [...p.approvedBy, ...requesterIds(p)], p.highRisk);

  if (p.beneficiaryMismatch && (input.mismatchResolution ?? "").trim().length < 5) {
    throw new PaymentError("This payment has an unresolved beneficiary mismatch flag. Describe how it was resolved before reconciling.", 422, "validation", { mismatchResolution: "Required while flagged" });
  }
  let settled: number;
  try {
    settled = parseAmountToMinor(input.settledAmount, p.currency);
  } catch (e) {
    throw new PaymentError((e as MoneyError).message, 422, "validation", { settledAmount: (e as MoneyError).message });
  }
  const net = p.amountMinor + p.adjustmentMinor;
  if (settled !== net) {
    throw new PaymentError(
      `The statement amount (${formatMinor(settled, p.currency)}) differs from the ledger net amount (${formatMinor(net, p.currency)}). Record a return/partial/correction first, or flag an exception.`,
      422, "amount_mismatch", { settledAmount: "Does not match the ledger net amount" },
    );
  }
  const updated = await casTransition(p, "reconciled", {
    set: {
      reconciledBy: actor.id,
      reconciledAt: new Date(),
      reconciliation: { statementRef: input.statementRef, settledAmountMinor: settled, statementDate: input.statementDate || null, note: input.note || null },
      ...(p.beneficiaryMismatch ? { beneficiaryMismatch: false } : {}),
    },
  });
  await appendPaymentEvent({
    paymentId: id, candidateId: p.candidateId, kind: "reconciled", actorId: actor.id, fromStatus: "paid", toStatus: "reconciled",
    reason: input.note, meta: { statementRef: input.statementRef, settledAmountMinor: settled, mismatchResolution: p.beneficiaryMismatch ? input.mismatchResolution : undefined },
  });
  await auditPayment(actor, "status_change", updated, `Reconciled against ${input.statementRef}`, { before: { status: "paid" }, after: { status: "reconciled", statementRef: input.statementRef } });
  await clearExceptionTasks(updated, ["reconcile", "mismatch"], "Payment reconciled");
  return updated;
}
