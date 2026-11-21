import { connectDb } from "@/lib/db/connect";
import { Payment, type IPayment, type PaymentProvider } from "@/lib/db/models/payment";
import { PaymentApproval, type IPaymentApproval } from "@/lib/db/models/payment-approval";
import { hmacHex } from "@/lib/crypto/keys";
import { loadCandidateFor } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { assertCan, can, ForbiddenError } from "@/lib/rbac/can";
import { assertPaymentApprover } from "@/lib/sod";
import { diff } from "@/lib/audit";
import { buildPaymentFields, readinessIssues, type PaymentInput } from "./schema";
import { approvalProgress } from "./approvals";
import { assessRisk, classifyRecipient } from "./risk";
import { normalizeText } from "./destination";
import { PROVIDER_FOR_TYPE } from "./evidence";
import { PaymentConflictError, PaymentError } from "./errors";
import {
  appendPaymentEvent,
  auditPayment,
  casTransition,
  clearExceptionTasks,
  highRiskThresholdUsd,
  loadPaymentFor,
  paymentAuditShape,
} from "./core";

export const isDuplicateKey = (err: unknown, field?: string) => {
  const e = err as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
  if (e?.code !== 11000) return false;
  return field ? Object.keys(e.keyPattern ?? {}).includes(field) || (e.message ?? "").includes(field) : true;
};

/** Statuses in which money actually left (used for new/changed-recipient detection). */
const MONEY_MOVED = ["submitted", "processing", "paid", "reconciled", "reversed"] as const;

async function classifyAndAssess(f: ReturnType<typeof buildPaymentFields>, excludePaymentId?: string) {
  await connectDb();
  const recipientRelevant = f.type !== "payroll_settlement" && !!f.recipientName;
  const fingerprint = recipientRelevant ? hmacHex("payment-recipient", `${normalizeText(f.recipientName)}|${normalizeText(f.recipientDestination)}`) : null;
  let cls = { newRecipient: false, recipientChanged: false };
  if (fingerprint) {
    const prior = await Payment.find({
      candidateId: f.candidateId,
      type: { $ne: "payroll_settlement" },
      status: { $in: [...MONEY_MOVED] },
      ...(excludePaymentId ? { _id: { $ne: excludePaymentId } } : {}),
    })
      .sort({ createdAt: 1 })
      .select("recipientFingerprint")
      .lean<Pick<IPayment, "recipientFingerprint">[]>();
    cls = classifyRecipient(fingerprint, prior.map((p) => p.recipientFingerprint));
  }
  const risk = assessRisk({
    type: f.type,
    currency: f.currency,
    amountMinor: f.amountMinor,
    convertedCurrency: f.convertedCurrency,
    convertedAmountMinor: f.convertedAmountMinor,
    ...cls,
    thresholdUsd: await highRiskThresholdUsd(),
  });
  return { fingerprint, ...cls, risk };
}

/** Live preview used by the create form's high-risk indicator (no writes). */
export async function previewRisk(actor: SessionUser, input: PaymentInput, opts: { excludePaymentId?: string } = {}) {
  assertCan(actor, "payments.prepare");
  const f = buildPaymentFields(input);
  const c = await loadCandidateFor(actor, f.candidateId);
  if (!c) throw new PaymentError("Candidate not found", 404, "not_found");
  const a = await classifyAndAssess(f, opts.excludePaymentId);
  return { highRisk: a.risk.highRisk, requiredApprovals: a.risk.requiredApprovals, reasons: a.risk.reasons, newRecipient: a.newRecipient, recipientChanged: a.recipientChanged, destinationWasMasked: f.destinationWasMasked, convertedAmountMinor: f.convertedAmountMinor, convertedCurrency: f.convertedCurrency };
}

async function assertLinkable(candidateId: string, ids: (string | null | undefined)[]) {
  for (const id of ids) {
    if (!id) continue;
    const linked = await Payment.findById(id).select("candidateId").lean<Pick<IPayment, "candidateId">>();
    if (!linked || linked.candidateId !== candidateId) throw new PaymentError("The linked payment was not found for this candidate.", 422, "validation", { linkedPaymentId: "Linked payment not found for this candidate" });
  }
}

function persistable(f: ReturnType<typeof buildPaymentFields>, a: Awaited<ReturnType<typeof classifyAndAssess>>) {
  const { destinationWasMasked, ...fields } = f;
  void destinationWasMasked;
  return {
    ...fields,
    recipientFingerprint: a.fingerprint,
    newRecipient: a.newRecipient,
    recipientChanged: a.recipientChanged,
    amountUsdMinor: a.risk.amountUsdMinor,
    highRisk: a.risk.highRisk,
    riskReasons: a.risk.reasons,
    requiredApprovals: a.risk.requiredApprovals,
    providerName: (PROVIDER_FOR_TYPE[f.type] ?? "manual") as PaymentProvider,
  };
}

/* -------------------------------- create -------------------------------- */

export async function createPayment(actor: SessionUser, input: PaymentInput, opts: { requestKey?: string } = {}) {
  assertCan(actor, "payments.prepare");
  const f = buildPaymentFields(input);
  const candidate = await loadCandidateFor(actor, f.candidateId);
  if (!candidate) throw new PaymentError("Candidate not found", 404, "not_found");
  await assertLinkable(f.candidateId, [f.linkedPaymentId, f.retryOf]);

  const a = await classifyAndAssess(f);
  try {
    const doc = await Payment.create({
      ...persistable(f, a),
      status: "draft",
      createdBy: actor.id,
      requestKey: opts.requestKey ?? null,
    });
    const payment = doc.toObject() as IPayment;
    await appendPaymentEvent({
      paymentId: payment._id,
      candidateId: payment.candidateId,
      kind: "created",
      actorId: actor.id,
      toStatus: "draft",
      reason: payment.reason,
      linkedPaymentId: payment.linkedPaymentId,
      meta: { highRisk: payment.highRisk, retryOf: payment.retryOf ?? undefined },
    });
    await auditPayment(actor, "create", payment, `Created ${payment.type} payment draft`, { after: paymentAuditShape(payment) });
    return { payment, replay: false };
  } catch (err) {
    if (opts.requestKey && isDuplicateKey(err, "requestKey")) {
      const existing = await Payment.findOne({ createdBy: actor.id, requestKey: opts.requestKey }).lean<IPayment>();
      if (existing) return { payment: existing, replay: true };
    }
    if (isDuplicateKey(err, "providerReference")) throw new PaymentError("That provider/bank reference is already recorded on another payment.", 409, "duplicate_reference", { providerReference: "Already used on another payment" });
    throw err;
  }
}

/* ---------------------------- edit (Draft only) ---------------------------- */

export async function updateDraftPayment(actor: SessionUser, id: string, input: PaymentInput) {
  assertCan(actor, "payments.prepare");
  const before = await loadPaymentFor(actor, id);
  if (before.status !== "draft") {
    throw new PaymentError("Money fields are frozen once a payment leaves Draft. Reject it back to Draft, or cancel it and create a new linked payment.", 409, "frozen");
  }
  // roles that cannot see the stored (masked) destination must not blank it by leaving the field empty
  const keepDestination = !input.recipientDestination && !can(actor, "payments.destination.view") ? before.recipientDestination ?? undefined : input.recipientDestination;
  const f = buildPaymentFields({ ...input, recipientDestination: keepDestination ?? undefined, candidateId: before.candidateId }); // the candidate can never be changed
  await assertLinkable(f.candidateId, [f.linkedPaymentId, f.retryOf]);
  const a = await classifyAndAssess(f, id);
  const set = persistable(f, a);
  let after: IPayment | null;
  try {
    // the filter pins status:"draft" — the schema guard only allows money-field writes under that filter
    after = await Payment.findOneAndUpdate({ _id: id, status: "draft" }, { $set: set }, { returnDocument: "after" }).lean<IPayment>();
  } catch (err) {
    if (isDuplicateKey(err, "providerReference")) throw new PaymentError("That provider/bank reference is already recorded on another payment.", 409, "duplicate_reference", { providerReference: "Already used on another payment" });
    throw err;
  }
  if (!after) throw new PaymentConflictError();
  const d = diff(paymentAuditShape(before), paymentAuditShape(after));
  await appendPaymentEvent({ paymentId: id, candidateId: after.candidateId, kind: "edited", actorId: actor.id, reason: "Draft edited", meta: { fields: Object.keys(d.after).filter((k) => k !== "updatedAt") } });
  await auditPayment(actor, "update", after, "Edited draft payment", { before: d.before, after: d.after });
  return after;
}

/* ------------------------ Draft → Awaiting Approval ------------------------ */

export async function submitForApproval(actor: SessionUser, id: string) {
  assertCan(actor, "payments.prepare");
  const p = await loadPaymentFor(actor, id);
  if (p.status !== "draft") throw new PaymentError("Only a Draft payment can be sent for approval.", 409, "illegal_transition");

  const issues = readinessIssues(p);
  if (issues.length) throw new PaymentError(issues.join(" "), 422, "not_ready");

  // re-assess risk with the CURRENT history of the candidate (a recipient may have been used since the draft)
  const rebuilt = {
    candidateId: p.candidateId,
    type: p.type,
    currency: p.currency,
    amountMinor: p.amountMinor,
    convertedCurrency: p.convertedCurrency ?? null,
    convertedAmountMinor: p.convertedAmountMinor ?? null,
    recipientName: p.recipientName ?? null,
    recipientDestination: p.recipientDestination ?? null,
  } as ReturnType<typeof buildPaymentFields>;
  const a = await classifyAndAssess(rebuilt, id);

  const updated = await casTransition(p, "awaiting_approval", {
    set: {
      requestedBy: actor.id,
      requestedAt: new Date(),
      highRisk: a.risk.highRisk,
      riskReasons: a.risk.reasons,
      requiredApprovals: a.risk.requiredApprovals,
      newRecipient: a.newRecipient,
      recipientChanged: a.recipientChanged,
      amountUsdMinor: a.risk.amountUsdMinor,
      approvedBy: [],
      exceptionReason: null,
    },
    inc: { approvalRound: 1 },
  });
  await appendPaymentEvent({
    paymentId: id,
    candidateId: p.candidateId,
    kind: "approval_requested",
    actorId: actor.id,
    fromStatus: "draft",
    toStatus: "awaiting_approval",
    meta: { highRisk: updated.highRisk, requiredApprovals: updated.requiredApprovals, riskReasons: updated.riskReasons, round: updated.approvalRound },
  });
  await auditPayment(actor, "status_change", updated, `Sent for approval (${updated.requiredApprovals} approval${updated.requiredApprovals > 1 ? "s" : ""} required${updated.highRisk ? ", high-risk" : ""})`, {
    before: { status: "draft" },
    after: { status: "awaiting_approval", highRisk: updated.highRisk, riskReasons: updated.riskReasons },
  });
  return updated;
}

/* -------------------------------- approve -------------------------------- */

/** People who may never approve/reconcile this payment: whoever created or requested it. */
export const requesterIds = (p: Pick<IPayment, "createdBy" | "requestedBy">) => [...new Set([p.createdBy, p.requestedBy].filter(Boolean) as string[])];

export async function approvePayment(actor: SessionUser, id: string, note?: string) {
  assertCan(actor, "payments.approve");
  const p = await loadPaymentFor(actor, id);
  if (p.status !== "awaiting_approval") throw new PaymentError("This payment is not awaiting approval.", 409, "illegal_transition");

  const round = p.approvalRound;
  const decisions = await PaymentApproval.find({ paymentId: id, round }).lean<IPaymentApproval[]>();
  const priorApprovers = decisions.filter((d) => d.decision === "approve").map((d) => d.approverId);
  // SoD: the requester can never approve; a second approval must come from a different user
  for (const r of requesterIds(p)) assertPaymentApprover(actor.id, r, priorApprovers);
  if (decisions.some((d) => d.approverId === actor.id)) throw new PaymentError("You have already recorded a decision on this payment.", 409, "duplicate_decision");

  // risk can only escalate between request and approval (e.g. the recipient was used by another payment meanwhile)
  const rebuilt = {
    candidateId: p.candidateId, type: p.type, currency: p.currency, amountMinor: p.amountMinor,
    convertedCurrency: p.convertedCurrency ?? null, convertedAmountMinor: p.convertedAmountMinor ?? null,
    recipientName: p.recipientName ?? null, recipientDestination: p.recipientDestination ?? null,
  } as ReturnType<typeof buildPaymentFields>;
  const fresh = await classifyAndAssess(rebuilt, id);
  const highRisk = p.highRisk || fresh.risk.highRisk;
  const required = Math.max(p.requiredApprovals, fresh.risk.requiredApprovals);
  if (required !== p.requiredApprovals || highRisk !== p.highRisk) {
    await Payment.updateOne({ _id: id, status: "awaiting_approval", approvalRound: round }, { $set: { highRisk, requiredApprovals: required, riskReasons: [...new Set([...p.riskReasons, ...fresh.risk.reasons])] } });
  }

  try {
    await PaymentApproval.create({ paymentId: id, round, requestedBy: p.requestedBy ?? p.createdBy, approverId: actor.id, decision: "approve", reason: note });
  } catch (err) {
    if (isDuplicateKey(err)) throw new PaymentError("You have already recorded a decision on this payment.", 409, "duplicate_decision");
    throw err;
  }

  const all = await PaymentApproval.find({ paymentId: id, round }).sort({ createdAt: 1 }).lean<IPaymentApproval[]>();
  const progress = approvalProgress({ required, excludedIds: requesterIds(p), approvals: all });
  await appendPaymentEvent({
    paymentId: id, candidateId: p.candidateId, kind: "approved", actorId: actor.id,
    reason: note, meta: { round, count: progress.count, required, highRisk },
  });
  await auditPayment(actor, "approve", p, `Approval ${progress.count} of ${required} recorded`, { reason: note, after: { round, approvals: progress.count, required } });

  if (!progress.satisfied) return { payment: { ...p, highRisk, requiredApprovals: required }, progress, finalized: false };

  // final approval: only the request that wins the compare-and-set moves the status
  try {
    const approved = await casTransition(p, "approved", {
      set: { approvedBy: progress.approvedIds, approvedAt: new Date() },
      extraFilter: { approvalRound: round },
    });
    await appendPaymentEvent({ paymentId: id, candidateId: p.candidateId, kind: "status_change", actorId: actor.id, fromStatus: "awaiting_approval", toStatus: "approved", reason: `Approved by ${progress.count} approver(s)`, meta: { approvers: progress.approvedIds } });
    await auditPayment(actor, "status_change", approved, "Payment approved", { before: { status: "awaiting_approval" }, after: { status: "approved", approvedBy: progress.approvedIds } });
    return { payment: approved, progress, finalized: true };
  } catch (err) {
    if (err instanceof PaymentConflictError) {
      const now = await Payment.findById(id).lean<IPayment>();
      return { payment: now!, progress, finalized: now?.status === "approved" };
    }
    throw err;
  }
}

/* -------------------------------- reject -------------------------------- */

export async function rejectPayment(actor: SessionUser, id: string, reason: string) {
  assertCan(actor, "payments.approve");
  if (reason.trim().length < 5) throw new PaymentError("A rejection reason is required.", 422, "validation", { reason: "Enter a reason" });
  const p = await loadPaymentFor(actor, id);
  if (p.status !== "awaiting_approval") throw new PaymentError("This payment is not awaiting approval.", 409, "illegal_transition");
  for (const r of requesterIds(p)) assertPaymentApprover(actor.id, r); // requester can't decide on their own request

  try {
    await PaymentApproval.create({ paymentId: id, round: p.approvalRound, requestedBy: p.requestedBy ?? p.createdBy, approverId: actor.id, decision: "reject", reason });
  } catch (err) {
    if (isDuplicateKey(err)) throw new PaymentError("You have already recorded a decision on this payment.", 409, "duplicate_decision");
    throw err;
  }
  const back = await casTransition(p, "draft", { set: { approvedBy: [], requestedBy: null, requestedAt: null, exceptionReason: `Rejected: ${reason}` }, extraFilter: { approvalRound: p.approvalRound } });
  await appendPaymentEvent({ paymentId: id, candidateId: p.candidateId, kind: "rejected", actorId: actor.id, fromStatus: "awaiting_approval", toStatus: "draft", reason, meta: { round: p.approvalRound } });
  await auditPayment(actor, "reject", back, "Payment rejected and sent back to Draft", { reason, before: { status: "awaiting_approval" }, after: { status: "draft" } });
  return back;
}

/* -------------------------------- cancel -------------------------------- */

export async function cancelPayment(actor: SessionUser, id: string, reason: string) {
  if (reason.trim().length < 5) throw new PaymentError("A cancellation reason is required.", 422, "validation", { reason: "Enter a reason" });
  const p = await loadPaymentFor(actor, id);
  const early = p.status === "draft" || p.status === "awaiting_approval";
  const ok = early ? can(actor, "payments.prepare") || can(actor, "payments.approve") || can(actor, "payments.submit") : can(actor, "payments.submit") || can(actor, "payments.reconcile");
  if (!ok) throw new ForbiddenError();
  const cancelled = await casTransition(p, "cancelled", { set: { cancelledAt: new Date(), exceptionReason: reason } });
  await appendPaymentEvent({ paymentId: id, candidateId: p.candidateId, kind: "cancellation", actorId: actor.id, fromStatus: p.status, toStatus: "cancelled", reason });
  await auditPayment(actor, "status_change", cancelled, "Payment cancelled", { reason, before: { status: p.status }, after: { status: "cancelled" } });
  await clearExceptionTasks(cancelled, ["reconcile", "failed"], "Payment cancelled");
  return cancelled;
}
