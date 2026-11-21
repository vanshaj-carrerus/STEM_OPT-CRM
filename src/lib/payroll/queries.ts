import { connectDb } from "@/lib/db/connect";
import { can, candidateScopeFilter, type Actor } from "@/lib/rbac/can";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { PayrollBatch, type IPayrollBatch } from "@/lib/db/models/payroll-batch";
import { PayrollItem, type IPayrollItem } from "@/lib/db/models/payroll-item";
import { PayrollSyncLog, type IPayrollSyncLog } from "@/lib/db/models/payroll-sync-log";
import { EmergencyPayrollItem, type IEmergencyPayrollItem } from "@/lib/db/models/emergency-payroll-item";
import { userNameMap } from "@/lib/users/directory";
import { User, type IUser } from "@/lib/db/models/user";
import { PAYROLL_STATUSES, type PayrollStatus } from "./rules";
import { batchView, itemView, type BatchView, type ItemView } from "./serialize";
import { PayrollError } from "./errors";

/**
 * Read models for pages, APIs and the dashboard. Every function takes the actor and trims server-side:
 * payroll amounts are stripped unless `payroll.amounts.view`, candidates are record-scope filtered.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const json = <T>(v: unknown) => JSON.parse(JSON.stringify(v)) as T;

/** null = actor sees every candidate; otherwise the list of candidate ids in their scope. */
async function scopedCandidateIds(actor: Actor): Promise<string[] | null> {
  if (can(actor, "candidates.viewAll")) return null;
  const rows = await Candidate.find(candidateScopeFilter(actor)).select("_id").lean<ICandidate[]>();
  return rows.map((r) => r._id);
}

/* --------------------------------- batches --------------------------------- */

export interface BatchListQuery {
  status?: string;
  from?: string; // pay date >=
  to?: string; // pay date <=
  reconciliation?: string;
  page?: number;
  pageSize?: number;
}

export async function listBatches(actor: Actor, q: BatchListQuery = {}) {
  if (!can(actor, "payroll.view")) throw new PayrollError("Not allowed.", 404);
  await connectDb();
  const filter: Record<string, unknown> = {};
  if (q.status && (PAYROLL_STATUSES as readonly string[]).includes(q.status)) filter.status = q.status;
  if (q.reconciliation && ["pending", "reconciled", "mismatch"].includes(q.reconciliation)) {
    filter.status = "processed";
    filter["reconciliation.status"] = q.reconciliation;
  }
  const date: Record<string, string> = {};
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) date.$gte = q.from;
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) date.$lte = q.to;
  if (Object.keys(date).length) filter["payPeriod.payDate"] = date;
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(100, q.pageSize ?? 25);
  const [rows, total] = await Promise.all([
    PayrollBatch.find(filter).sort({ "payPeriod.payDate": -1, createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean<IPayrollBatch[]>(),
    PayrollBatch.countDocuments(filter),
  ]);
  const names = await userNameMap(rows.flatMap((r) => [r.preparedBy, r.approvedBy]));
  return { rows: rows.map((r) => ({ ...batchView(actor, r), preparedByName: names[r.preparedBy], approvedByName: r.approvedBy ? names[r.approvedBy] : undefined })), total, page, pageSize };
}

export interface BatchDetail {
  batch: Partial<BatchView> & { preparedByName?: string; approvedByName?: string };
  items: (Partial<ItemView> & { candidateCode?: string; candidateName?: string })[];
  editorNames: string[];
  names: Record<string, string>;
  logs: (IPayrollSyncLog & { createdAt: string })[];
  linkedCorrections: { _id: string; status: PayrollStatus }[];
  adjusts?: { _id: string; status: PayrollStatus } | null;
}

export async function getBatchDetail(actor: Actor, id: string): Promise<BatchDetail> {
  if (!can(actor, "payroll.view")) throw new PayrollError("Payroll batch not found.", 404);
  await connectDb();
  const b = await PayrollBatch.findById(id).lean<IPayrollBatch>();
  if (!b) throw new PayrollError("Payroll batch not found.", 404);
  const items = await PayrollItem.find({ batchId: id }).sort({ employeeName: 1 }).lean<IPayrollItem[]>();
  const candIds = items.map((i) => i.candidateId).filter(Boolean) as string[];
  const scope = candIds.length ? await Candidate.find({ _id: { $in: candIds }, ...candidateScopeFilter(actor) }).select("legalName candidateCode").lean<ICandidate[]>() : [];
  const byId = new Map(scope.map((c) => [c._id, c]));
  const names = await userNameMap([b.preparedBy, b.approvedBy, b.processedBy, ...(b.editorIds ?? []), ...(b.approvalHistory ?? []).map((a) => a.by)]);
  const logs = await PayrollSyncLog.find({ batchId: id }).sort({ createdAt: -1 }).limit(50).lean<IPayrollSyncLog[]>();
  const corr = await PayrollBatch.find({ adjustsBatchId: id }).select("status").lean<IPayrollBatch[]>();
  const adj = b.adjustsBatchId ? await PayrollBatch.findById(b.adjustsBatchId).select("status").lean<IPayrollBatch>() : null;
  return {
    batch: { ...batchView(actor, b), preparedByName: names[b.preparedBy], approvedByName: b.approvedBy ? names[b.approvedBy] : undefined },
    items: items.map((i) => {
      const c = i.candidateId ? byId.get(i.candidateId) : undefined;
      return { ...itemView(actor, i), candidateCode: c?.candidateCode, candidateName: c?.legalName ?? (i.candidateId ? "Restricted" : i.employeeName) };
    }),
    editorNames: (b.editorIds ?? []).map((e) => names[e] ?? "Unknown user"),
    names,
    logs: json(logs),
    linkedCorrections: corr.map((c) => ({ _id: c._id, status: c.status })),
    adjusts: adj ? { _id: adj._id, status: adj.status } : null,
  };
}

/* ------------------------------ mapping & logs ------------------------------ */

export async function listMappingOverview(actor: Actor, q: { q?: string; view?: "unmapped" | "mapped"; page?: number } = {}) {
  if (!can(actor, "payroll.view")) throw new PayrollError("Not allowed.", 404);
  await connectDb();
  const and: Record<string, unknown>[] = [candidateScopeFilter(actor), { stage: { $nin: ["archived", "offboarded"] } }];
  and.push(q.view === "mapped" ? { "payrollMapping.employeeId": { $exists: true, $ne: null } } : { $or: [{ "payrollMapping.employeeId": { $exists: false } }, { "payrollMapping.employeeId": null }] });
  if (q.q?.trim()) {
    const re = new RegExp(esc(q.q.trim().slice(0, 80)), "i");
    and.push({ $or: [{ legalName: re }, { candidateCode: re }, { emailLower: re }] });
  }
  const filter = { $and: and };
  const page = Math.max(1, q.page ?? 1);
  const [rows, total, unmappedTotal] = await Promise.all([
    Candidate.find(filter).sort({ legalName: 1 }).skip((page - 1) * 50).limit(50).select("legalName candidateCode stage payrollMapping").lean<ICandidate[]>(),
    Candidate.countDocuments(filter),
    Candidate.countDocuments({ $and: [candidateScopeFilter(actor), { stage: { $nin: ["archived", "offboarded"] } }, { $or: [{ "payrollMapping.employeeId": { $exists: false } }, { "payrollMapping.employeeId": null }] }] }),
  ]);
  return {
    rows: rows.map((r) => ({ _id: r._id, candidateCode: r.candidateCode, legalName: r.legalName, stage: r.stage, mapping: r.payrollMapping ? { employeeId: r.payrollMapping.employeeId, companyRef: r.payrollMapping.companyRef, payType: r.payrollMapping.payType, paySchedule: r.payrollMapping.paySchedule } : null })),
    total, unmappedTotal, page,
  };
}

export async function listSyncLogs(actor: Actor, opts: { onlyProblems?: boolean; limit?: number } = {}) {
  if (!can(actor, "payroll.view")) throw new PayrollError("Not allowed.", 404);
  await connectDb();
  const filter: Record<string, unknown> = opts.onlyProblems ? { level: { $in: ["warn", "error"] } } : {};
  const rows = await PayrollSyncLog.find(filter).sort({ createdAt: -1 }).limit(opts.limit ?? 50).lean<IPayrollSyncLog[]>();
  return json<(IPayrollSyncLog & { createdAt: string })[]>(rows);
}

/* ----------------------------- emergency payroll ----------------------------- */

export type EmergencyView = Omit<IEmergencyPayrollItem, "history" | "createdAt" | "updatedAt" | "requestedPayDate"> & {
  requestedPayDate: string;
  createdAt: string;
  history: (Omit<IEmergencyPayrollItem["history"][number], "at"> & { at: string; byName?: string })[];
  candidateCode?: string;
  candidateName?: string;
  ownerName?: string;
  requestedByName?: string;
  batchStatus?: string;
  batchReconciliation?: string;
};

async function toEmergencyViews(actor: Actor, rows: IEmergencyPayrollItem[], withHistory: boolean): Promise<EmergencyView[]> {
  const cands = await Candidate.find({ _id: { $in: rows.map((r) => r.candidateId) } }).select("legalName candidateCode").lean<ICandidate[]>();
  const cmap = new Map(cands.map((c) => [c._id, c]));
  const batches = await PayrollBatch.find({ _id: { $in: rows.map((r) => r.batchId).filter(Boolean) as string[] } }).select("status reconciliation").lean<IPayrollBatch[]>();
  const bmap = new Map(batches.map((b) => [b._id, b]));
  const names = await userNameMap(rows.flatMap((r) => [r.ownerId, r.requestedBy, ...(withHistory ? r.history.map((h) => h.by) : [])]));
  return rows.map((r) => {
    const c = cmap.get(r.candidateId);
    const b = r.batchId ? bmap.get(r.batchId) : undefined;
    const v = json<EmergencyView>(r);
    if (!withHistory) v.history = [];
    else v.history = v.history.map((h) => ({ ...h, byName: h.by ? names[h.by] : "System" }));
    return { ...v, candidateCode: c?.candidateCode, candidateName: c?.legalName, ownerName: r.ownerId ? names[r.ownerId] : undefined, requestedByName: names[r.requestedBy], batchStatus: b?.status, batchReconciliation: b?.reconciliation?.status };
  });
}

export async function listEmergencyItems(actor: Actor, input: { view?: "active" | "resolved"; active?: boolean; resolved?: boolean; q?: string; candidateId?: string; page?: number } = {}) {
  if (!can(actor, "emergency.view")) throw new PayrollError("Not allowed.", 404);
  await connectDb();
  const opts = { ...input, view: input.view ?? (input.resolved ? "resolved" : "active") } as typeof input & { view: "active" | "resolved" };
  const and: Record<string, unknown>[] = [{ isActive: opts.view === "active" }];
  const ids = await scopedCandidateIds(actor);
  if (ids) and.push({ candidateId: { $in: ids } });
  if (opts.candidateId) and.push({ candidateId: opts.candidateId });
  if (opts.q?.trim()) {
    const re = new RegExp(esc(opts.q.trim().slice(0, 80)), "i");
    const matches = await Candidate.find({ $or: [{ legalName: re }, { candidateCode: re }] }).select("_id").limit(200).lean<ICandidate[]>();
    and.push({ $or: [{ reason: re }, { candidateId: { $in: matches.map((m) => m._id) } }] });
  }
  const page = Math.max(1, opts.page ?? 1);
  const sort: Record<string, 1 | -1> = opts.view === "active" ? { actionRequired: -1, requestedPayDate: 1 } : { resolvedAt: -1 };
  const [rows, total] = await Promise.all([
    EmergencyPayrollItem.find({ $and: and }).sort(sort).skip((page - 1) * 50).limit(50).lean<IEmergencyPayrollItem[]>(),
    EmergencyPayrollItem.countDocuments({ $and: and }),
  ]);
  return { rows: await toEmergencyViews(actor, rows, false), total, page };
}

export async function getEmergencyItem(actor: Actor, id: string) {
  if (!can(actor, "emergency.view")) throw new PayrollError("Not found.", 404);
  await connectDb();
  const item = await EmergencyPayrollItem.findById(id).lean<IEmergencyPayrollItem>();
  if (!item) throw new PayrollError("Emergency payroll item not found.", 404);
  const ids = await scopedCandidateIds(actor);
  if (ids && !ids.includes(item.candidateId)) throw new PayrollError("Emergency payroll item not found.", 404);
  return (await toEmergencyViews(actor, [item], true))[0];
}

/** Active batches an emergency item can be linked to. */
export async function listLinkableBatches() {
  await connectDb();
  const rows = await PayrollBatch.find({ status: { $in: ["draft", "needs_review", "approved", "processing", "failed"] } }).sort({ "payPeriod.payDate": -1 }).limit(50).lean<IPayrollBatch[]>();
  return rows.map((b) => ({ _id: b._id, label: `${b.payPeriod.start} – ${b.payPeriod.end} (pay ${b.payPeriod.payDate}) · ${b.status}` }));
}

/** Active users who can own an emergency payroll item. */
export async function listPayrollOwners() {
  await connectDb();
  const rows = await User.find({ active: true, role: { $in: ["super_admin", "payroll_preparer", "payroll_approver", "compliance_manager"] } }).select("name role").sort({ name: 1 }).lean<IUser[]>();
  return rows.map((u) => ({ id: u._id, name: u.name }));
}

/* ------------------------------ candidate record ------------------------------ */

export async function candidatePayroll(actor: Actor, candidateId: string) {
  await connectDb();
  const items = await PayrollItem.find({ candidateId }).sort({ createdAt: -1 }).limit(50).lean<IPayrollItem[]>();
  const batches = await PayrollBatch.find({ _id: { $in: items.map((i) => i.batchId) } }).lean<IPayrollBatch[]>();
  const bmap = new Map(batches.map((b) => [b._id, b]));
  const history = items
    .map((i) => ({ item: itemView(actor, i), batch: bmap.get(i.batchId) ? batchView(actor, bmap.get(i.batchId)!) : null }))
    .sort((a, b) => String(b.batch?.payPeriod?.payDate ?? "").localeCompare(String(a.batch?.payPeriod?.payDate ?? "")));
  const emergencies = can(actor, "emergency.view")
    ? await toEmergencyViews(actor, await EmergencyPayrollItem.find({ candidateId }).sort({ createdAt: -1 }).limit(50).lean<IEmergencyPayrollItem[]>(), true)
    : [];
  return { history, emergencies };
}

/* -------------------------------- dashboard -------------------------------- */

export interface PayrollDashboard {
  batchesByStatus: Record<PayrollStatus, number>;
  activeEmergency: number;
  emergencyActionRequired: number;
  emergencyResolved30d: number;
  reconciliationDifferences: number;
  unreconciledProcessed: number;
  /** Only present with payroll.amounts.view. */
  reconciliationDifferenceTotalCents?: number;
}

export async function payrollDashboard(actor: Actor): Promise<PayrollDashboard> {
  await connectDb();
  const out: PayrollDashboard = {
    batchesByStatus: Object.fromEntries(PAYROLL_STATUSES.map((s) => [s, 0])) as Record<PayrollStatus, number>,
    activeEmergency: 0, emergencyActionRequired: 0, emergencyResolved30d: 0, reconciliationDifferences: 0, unreconciledProcessed: 0,
  };
  if (can(actor, "payroll.view")) {
    const grouped = await PayrollBatch.aggregate<{ _id: PayrollStatus; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    for (const g of grouped) if (g._id in out.batchesByStatus) out.batchesByStatus[g._id] = g.n;
    const [diff, unrec] = await Promise.all([
      PayrollBatch.find({ status: "processed", "reconciliation.status": "mismatch" }).select("reconciliation").lean<IPayrollBatch[]>(),
      PayrollBatch.countDocuments({ status: "processed", "reconciliation.status": "pending" }),
    ]);
    out.reconciliationDifferences = diff.length;
    out.unreconciledProcessed = unrec;
    if (can(actor, "payroll.amounts.view")) out.reconciliationDifferenceTotalCents = diff.reduce((s, b) => s + Math.abs(b.reconciliation?.differenceCents ?? 0), 0);
  }
  if (can(actor, "emergency.view")) {
    const ids = await scopedCandidateIds(actor);
    const scope = ids ? { candidateId: { $in: ids } } : {};
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [active, action, resolved] = await Promise.all([
      EmergencyPayrollItem.countDocuments({ ...scope, isActive: true }),
      EmergencyPayrollItem.countDocuments({ ...scope, isActive: true, actionRequired: true }),
      EmergencyPayrollItem.countDocuments({ ...scope, status: "resolved", resolvedAt: { $gte: since } }),
    ]);
    out.activeEmergency = active;
    out.emergencyActionRequired = action;
    out.emergencyResolved30d = resolved;
  }
  return out;
}

/** Candidates (in the actor's scope) that are mapped to a Gusto employee — the picker for manual item entry. */
export async function listMappedCandidates(actor: Actor) {
  if (!can(actor, "payroll.view")) return [];
  await connectDb();
  const rows = await Candidate.find({ $and: [candidateScopeFilter(actor), { "payrollMapping.employeeId": { $exists: true, $ne: null } }, { stage: { $nin: ["archived"] } }] })
    .sort({ legalName: 1 })
    .limit(500)
    .select("legalName candidateCode")
    .lean<ICandidate[]>();
  return rows.map((r) => ({ id: r._id, label: `${r.legalName} (${r.candidateCode})` }));
}
