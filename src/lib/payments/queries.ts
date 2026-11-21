import { connectDb } from "@/lib/db/connect";
import { Payment, type IPayment } from "@/lib/db/models/payment";
import { PaymentApproval, type IPaymentApproval } from "@/lib/db/models/payment-approval";
import { PaymentEvent, type IPaymentEvent } from "@/lib/db/models/payment-event";
import { PaymentReceipt, type IPaymentReceipt } from "@/lib/db/models/payment-receipt";
import { Candidate } from "@/lib/db/models/candidate";
import type { SessionUser } from "@/lib/auth/session";
import { assertCan, can, candidateScopeFilter, type Actor } from "@/lib/rbac/can";
import { userNameMap } from "@/lib/users/directory";
import { getSetting } from "@/lib/settings";
import { PAYMENT_STATUSES, type PaymentStatus } from "./rules";
import { settledTotalsMinor } from "./queries-pure";
import { toPaymentView, type PaymentView } from "./view";
import { loadPaymentFor } from "./core";
import { requesterIds } from "./service";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Record-level scope: roles without candidates.viewAll only see payments of candidates assigned to them. */
export async function paymentScopeFilter(actor: Actor): Promise<Record<string, unknown>> {
  if (can(actor, "candidates.viewAll")) return {};
  await connectDb();
  const ids = await Candidate.distinct("_id", candidateScopeFilter(actor));
  return { candidateId: { $in: ids as string[] } };
}

/* -------------------------------- dashboard -------------------------------- */

export interface PaymentsDashboard {
  byStatus: Record<PaymentStatus, number>;
  pendingApprovals: number; // status = awaiting_approval
  failed: number;
  reversed: number;
  unreconciled: number; // status = paid (paid, not yet reconciled)
  /** instructed amounts in minor units, per currency then status — never summed across currencies */
  totalsByCurrencyAndStatus: Record<string, Partial<Record<PaymentStatus, number>>>;
}

/**
 * Counts and totals for the dashboard. Built from ONE aggregation over the same scope filter `listPayments` uses, so
 * every dashboard number reconciles with the corresponding filtered ledger list (AC-18):
 *   pendingApprovals ⇔ listPayments({status:"awaiting_approval"}), failed ⇔ {status:"failed"},
 *   reversed ⇔ {status:"reversed"}, unreconciled ⇔ {status:"paid"}.
 */
export async function paymentsDashboard(actor: Actor): Promise<PaymentsDashboard> {
  assertCan(actor, "payments.view");
  await connectDb();
  const scope = await paymentScopeFilter(actor);
  const groups = await Payment.aggregate<{ _id: { status: PaymentStatus; currency: string }; count: number; amountMinor: number }>([
    { $match: scope },
    { $group: { _id: { status: "$status", currency: "$currency" }, count: { $sum: 1 }, amountMinor: { $sum: "$amountMinor" } } },
  ]);
  const byStatus = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s, 0])) as Record<PaymentStatus, number>;
  const totals: PaymentsDashboard["totalsByCurrencyAndStatus"] = {};
  for (const g of groups) {
    byStatus[g._id.status] += g.count;
    (totals[g._id.currency] ??= {})[g._id.status] = g.amountMinor;
  }
  return {
    byStatus,
    pendingApprovals: byStatus.awaiting_approval,
    failed: byStatus.failed,
    reversed: byStatus.reversed,
    unreconciled: byStatus.paid,
    totalsByCurrencyAndStatus: totals,
  };
}

/* --------------------------------- listing --------------------------------- */

export interface PaymentFilters {
  candidateId?: string;
  type?: string;
  /** one status or a comma-separated list */
  status?: string;
  currency?: string;
  /** date-only bounds applied to the creation date (UTC) */
  from?: string;
  to?: string;
  q?: string;
  /** all (default) | attention (paid-unreconciled, failed, reversed, mismatch-flagged) | approvals (pending MY approval) */
  view?: "all" | "attention" | "approvals";
  page?: number;
  pageSize?: number;
}

const dateStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dateEnd = (d: string) => new Date(`${d}T23:59:59.999Z`);

export async function buildPaymentFilter(actor: Actor, f: PaymentFilters): Promise<Record<string, unknown>> {
  const and: Record<string, unknown>[] = [await paymentScopeFilter(actor)];
  if (f.candidateId) and.push({ candidateId: f.candidateId });
  if (f.type) and.push({ type: f.type });
  if (f.status) {
    const list = f.status.split(",").map((s) => s.trim()).filter((s) => (PAYMENT_STATUSES as readonly string[]).includes(s));
    if (list.length) and.push({ status: { $in: list } });
  }
  if (f.currency) and.push({ currency: f.currency.toUpperCase() });
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) and.push({ createdAt: { $gte: dateStart(f.from) } });
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) and.push({ createdAt: { $lte: dateEnd(f.to) } });
  if (f.q?.trim()) {
    const q = f.q.trim().slice(0, 80);
    const re = new RegExp(escapeRe(q), "i");
    and.push({ $or: [{ recipientName: re }, { providerReference: re }, { reason: re }, { invoiceRef: re }, { _id: q }] });
  }
  if (f.view === "attention") and.push({ $or: [{ status: { $in: ["paid", "failed", "reversed"] } }, { beneficiaryMismatch: true }] });
  return and.length === 1 ? and[0] : { $and: and };
}

async function hydrate(actor: Actor, rows: IPayment[]): Promise<PaymentView[]> {
  const thresholdUsd = await getSetting("payments.highRiskThresholdUsd");
  const candIds = [...new Set(rows.map((r) => r.candidateId))];
  const cands = candIds.length ? await Candidate.find({ _id: { $in: candIds } }).select("candidateCode legalName").lean<{ _id: string; candidateCode: string; legalName: string }[]>() : [];
  const candidates = Object.fromEntries(cands.map((c) => [c._id, { code: c.candidateCode, name: c.legalName }]));
  const users = await userNameMap(rows.flatMap((r) => [r.createdBy, r.requestedBy, r.submittedBy, r.reconciledBy, ...(r.approvedBy ?? [])]));
  return rows.map((r) => toPaymentView(actor, r, { thresholdUsd, candidates, users }));
}

export async function listPayments(actor: SessionUser, f: PaymentFilters = {}) {
  assertCan(actor, "payments.view");
  await connectDb();
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 25));
  const filter = await buildPaymentFilter(actor, f);

  if (f.view === "approvals") {
    // queue of payments THIS user may act on: never their own requests, never ones they already decided this round
    if (!can(actor, "payments.approve")) return { rows: [], total: 0, page, pageSize };
    const pending = await Payment.find({ $and: [filter, { status: "awaiting_approval" }, { createdBy: { $ne: actor.id } }, { requestedBy: { $ne: actor.id } }] })
      .sort({ requestedAt: 1 })
      .limit(500)
      .lean<IPayment[]>();
    const mine = await PaymentApproval.find({ approverId: actor.id, paymentId: { $in: pending.map((p) => p._id) } }).select("paymentId round").lean<IPaymentApproval[]>();
    const decided = new Set(mine.map((m) => `${m.paymentId}:${m.round}`));
    const actionable = pending.filter((p) => !requesterIds(p).includes(actor.id) && !decided.has(`${p._id}:${p.approvalRound}`));
    const slice = actionable.slice((page - 1) * pageSize, page * pageSize);
    return { rows: await hydrate(actor, slice), total: actionable.length, page, pageSize };
  }

  const [rows, total] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean<IPayment[]>(),
    Payment.countDocuments(filter),
  ]);
  return { rows: await hydrate(actor, rows), total, page, pageSize };
}

/** Everything matching the filter (capped) — used by the audited CSV export. */
export async function exportPayments(actor: SessionUser, f: PaymentFilters = {}, cap = 10_000) {
  assertCan(actor, "payments.view");
  await connectDb();
  const filter = await buildPaymentFilter(actor, f);
  const rows = await Payment.find(filter).sort({ createdAt: -1 }).limit(cap).lean<IPayment[]>();
  return hydrate(actor, rows);
}

/* ---------------------------------- detail ---------------------------------- */

export interface PaymentDetail {
  payment: PaymentView;
  events: (Omit<IPaymentEvent, "createdAt"> & { createdAt: string; actorName?: string })[];
  approvals: { id: string; round: number; approverId: string; approverName?: string; decision: "approve" | "reject"; reason?: string; createdAt: string }[];
  receipts: { id: string; kind: IPaymentReceipt["kind"]; fileName: string; sizeBytes: number; sha256: string; uploadedBy: string | null; uploadedByName?: string; createdAt: string; scanOk: boolean }[];
  linked: PaymentView[];
  parent: PaymentView | null;
  currentRoundApprovals: number;
}

export async function getPaymentDetail(actor: SessionUser, id: string): Promise<PaymentDetail> {
  const p = await loadPaymentFor(actor, id);
  await connectDb();
  const [events, approvals, receipts, children, parentDoc] = await Promise.all([
    PaymentEvent.find({ paymentId: id }).sort({ createdAt: 1 }).lean<IPaymentEvent[]>(),
    PaymentApproval.find({ paymentId: id }).sort({ createdAt: 1 }).lean<IPaymentApproval[]>(),
    PaymentReceipt.find({ paymentId: id }).sort({ createdAt: 1 }).lean<IPaymentReceipt[]>(),
    Payment.find({ $or: [{ linkedPaymentId: id }, { retryOf: id }] }).sort({ createdAt: 1 }).lean<IPayment[]>(),
    p.linkedPaymentId || p.retryOf ? Payment.findById(p.linkedPaymentId ?? p.retryOf).lean<IPayment>() : Promise.resolve(null),
  ]);
  const ids = [p.createdBy, p.requestedBy, p.submittedBy, p.reconciledBy, ...p.approvedBy, ...events.map((e) => e.actorId), ...approvals.map((a) => a.approverId), ...receipts.map((r) => r.uploadedBy)];
  const users = await userNameMap(ids);
  const [view] = await hydrate(actor, [p]);
  const linked = await hydrate(actor, children);
  const [parent] = parentDoc && parentDoc.candidateId === p.candidateId ? await hydrate(actor, [parentDoc]) : [null];
  return {
    payment: view,
    events: events.map((e) => ({ ...e, createdAt: new Date(e.createdAt).toISOString(), actorName: e.actorId ? users[e.actorId] : undefined })),
    approvals: approvals.map((a) => ({ id: a._id, round: a.round, approverId: a.approverId, approverName: users[a.approverId], decision: a.decision, reason: a.reason, createdAt: new Date(a.createdAt).toISOString() })),
    receipts: receipts.map((r) => ({ id: r._id, kind: r.kind, fileName: r.fileName, sizeBytes: r.sizeBytes, sha256: r.sha256, uploadedBy: r.uploadedBy ?? null, uploadedByName: r.uploadedBy ? users[r.uploadedBy] : undefined, createdAt: new Date(r.createdAt).toISOString(), scanOk: !!r.scan?.ok })),
    linked,
    parent: parent ?? null,
    currentRoundApprovals: approvals.filter((a) => a.round === p.approvalRound && a.decision === "approve").length,
  };
}

/* ------------------------- candidate ledger + totals ------------------------- */

export interface CandidateLedger {
  rows: PaymentView[];
  /** Payroll (Gusto) settlements and Ria/wire remittances are separate buckets per currency — never summed together. */
  totals: { payroll: Record<string, number>; remittance: Record<string, number> }; // MINOR units
}

export async function candidateLedger(actor: SessionUser, candidateId: string): Promise<CandidateLedger> {
  assertCan(actor, "payments.view");
  await connectDb();
  const rows = await Payment.find({ candidateId }).sort({ createdAt: -1 }).limit(500).lean<IPayment[]>();
  const views = await hydrate(actor, rows);
  return { rows: views, totals: settledTotalsMinor(views) };
}

export { settledTotalsMinor };
