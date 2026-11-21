import { connectDb } from "@/lib/db/connect";
import { Payment, type IPayment } from "@/lib/db/models/payment";
import { PaymentEvent, type IPaymentEvent, type PaymentEventKind } from "@/lib/db/models/payment-event";
import { loadCandidateFor } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/db/models/audit";
import { assertCan } from "@/lib/rbac/can";
import { cancelSystemTasks, upsertSystemTask } from "@/lib/tasks/core";
import { getSetting } from "@/lib/settings";
import { canTransitionPayment, PAYMENT_STATUS_LABELS, type PaymentStatus } from "./rules";
import { PaymentConflictError, PaymentError, PaymentNotFoundError } from "./errors";

/** Loads a payment only if the actor holds payments.view AND may see its candidate (record-level scope). */
export async function loadPaymentFor(actor: SessionUser, id: string): Promise<IPayment> {
  assertCan(actor, "payments.view");
  await connectDb();
  const p = await Payment.findById(id).lean<IPayment>();
  if (!p) throw new PaymentNotFoundError();
  const c = await loadCandidateFor(actor, p.candidateId);
  if (!c) throw new PaymentNotFoundError();
  return p;
}

export async function highRiskThresholdUsd(): Promise<number> {
  return getSetting("payments.highRiskThresholdUsd");
}

export interface NewEvent {
  paymentId: string;
  candidateId: string;
  kind: PaymentEventKind;
  actorId?: string | null;
  actorType?: IPaymentEvent["actorType"];
  fromStatus?: PaymentStatus | null;
  toStatus?: PaymentStatus | null;
  reason?: string;
  amountDeltaMinor?: number;
  currency?: string;
  linkedPaymentId?: string | null;
  providerEventId?: string | null;
  meta?: Record<string, unknown>;
}

export async function appendPaymentEvent(e: NewEvent) {
  await connectDb();
  return PaymentEvent.create({ ...e, actorType: e.actorType ?? (e.actorId ? "user" : "system"), amountDeltaMinor: e.amountDeltaMinor ?? 0 });
}

/**
 * Atomic status change guarded by the shared state machine AND a compare-and-set on the current status, so two
 * concurrent requests can never both move the same payment. Returns the updated payment.
 */
export async function casTransition(
  p: Pick<IPayment, "_id" | "status">,
  to: PaymentStatus,
  update: { set?: Record<string, unknown>; inc?: Record<string, number>; extraFilter?: Record<string, unknown> } = {},
): Promise<IPayment> {
  if (!canTransitionPayment(p.status, to)) {
    throw new PaymentError(`A ${PAYMENT_STATUS_LABELS[p.status]} payment cannot move to ${PAYMENT_STATUS_LABELS[to]}.`, 409, "illegal_transition");
  }
  await connectDb();
  const updated = await Payment.findOneAndUpdate(
    { _id: p._id, status: p.status, ...(update.extraFilter ?? {}) },
    { $set: { status: to, ...(update.set ?? {}) }, ...(update.inc ? { $inc: update.inc } : {}) },
    { returnDocument: "after" },
  ).lean<IPayment>();
  if (!updated) throw new PaymentConflictError();
  return updated;
}

/** Audit snapshot that never includes the destination reference (auditors may lack payments.destination.view). */
export function paymentAuditShape(p: Partial<IPayment>) {
  const o = { ...p } as Record<string, unknown>;
  delete o.recipientDestination;
  delete o.recipientFingerprint;
  delete o.requestKey;
  return o;
}

export async function auditPayment(
  actor: SessionUser | null,
  action: AuditAction,
  p: Pick<IPayment, "_id" | "candidateId">,
  summary: string,
  extra: { reason?: string; before?: unknown; after?: unknown; source?: "ui" | "api" | "worker" | "webhook" | "system" } = {},
) {
  await audit({ actor, action, entityType: "payment", entityId: p._id, candidateId: p.candidateId, summary, ...extra });
}

const todayUtc = () => new Date().toISOString().slice(0, 10);
const addDaysIso = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export type ExceptionKind = "failed" | "reversed" | "mismatch" | "returned" | "reconcile" | "unmatched_callback";

const EXCEPTION_TITLES: Record<ExceptionKind, string> = {
  failed: "Failed payment — review and re-issue or cancel",
  reversed: "Returned/reversed payment — review required",
  mismatch: "Beneficiary details mismatch — human review required",
  returned: "Partial return recorded — review required",
  reconcile: "Paid payment awaiting reconciliation",
  unmatched_callback: "Provider callback needs human review",
};

/**
 * Creates (or refreshes) an idempotent exception follow-up task for a payment. Never blocks the money workflow:
 * a task-service failure is logged and swallowed.
 */
export async function raiseExceptionTask(p: Pick<IPayment, "_id" | "candidateId">, kind: ExceptionKind, detail?: string) {
  try {
    await upsertSystemTask({
      candidateId: p.candidateId,
      kind: "payment",
      category: "payments",
      refKey: `payment:${p._id}:${kind}`,
      title: EXCEPTION_TITLES[kind],
      description: [`Payment ${p._id}`, detail].filter(Boolean).join(" — "),
      dueDate: kind === "reconcile" ? addDaysIso(2) : todayUtc(),
      priority: kind === "reconcile" ? "normal" : "high",
      meta: { paymentId: p._id, exception: kind },
    });
  } catch (err) {
    console.error("[payments] could not raise exception task", err);
  }
}

export async function clearExceptionTasks(p: Pick<IPayment, "_id" | "candidateId">, kinds: ExceptionKind[], reason: string) {
  try {
    for (const k of kinds) await cancelSystemTasks(p.candidateId, `payment:${p._id}:${k}`, reason);
  } catch (err) {
    console.error("[payments] could not clear exception tasks", err);
  }
}
