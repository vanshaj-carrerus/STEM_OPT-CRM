import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { audit } from "@/lib/audit";
import { assertCan, can, ForbiddenError, type Actor } from "@/lib/rbac/can";
import { assertPayrollApprover } from "@/lib/sod";
import { loadCandidateFor } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { isDateOnly, todayIn } from "@/lib/compliance/dates";
import { upsertSystemTask } from "@/lib/tasks/core";
import { Task, OPEN_TASK_STATUSES } from "@/lib/db/models/task";
import { PayrollBatch, type IPayrollBatch } from "@/lib/db/models/payroll-batch";
import { PayrollItem, type IPayrollItem } from "@/lib/db/models/payroll-item";
import { assertPayrollTransition, type PayrollStatus } from "./rules";
import { approvalBlockers, canEditBatch, computeTotals, statusAfterEdit } from "./batch-rules";
import { PAY_TYPES, computeItemFlags } from "./register-csv";
import { reconcileTotals } from "./reconcile";
import { parseMoneyToCents } from "./money";
import { planWebhookTransitions } from "./webhook-map";
import { linkEmergencyForCandidates, syncEmergencyItems } from "./emergency";
import { PayrollError } from "./errors";
import { logSync } from "./sync-log";

/**
 * Payroll batch service. Gusto is the system of record — nothing here calculates taxes or issues payroll; it tracks
 * the batch, its approvals, the provider reference and reconciliation.
 *
 * Invariants enforced here (and unit-tested in the pure modules they call):
 *  - every status change goes through `applyTransition` (canTransitionPayroll) and then re-derives emergency items;
 *  - every content edit goes through `registerEdit` (records the editor, bumps version, resets approval);
 *  - `processed` is reachable only from a verified provider event (webhook handler) or `recordProviderEvidence`;
 *  - audit/sync-log entries never contain payroll amounts (auditors lack `payroll.amounts.view`).
 */

const dateOnly = z.string().refine(isDateOnly, "Use a valid date (YYYY-MM-DD).");
const REF = /^[A-Za-z0-9._:-]{1,128}$/;
const refField = z.string().trim().regex(REF, "Use letters, numbers, dot, dash, underscore or colon only (max 128).");

type Who = SessionUser | (Actor & { email?: string }) | null;

export interface Ctx {
  actor?: Who;
  source?: "ui" | "api" | "webhook" | "system";
}

export async function loadBatch(id: string): Promise<IPayrollBatch> {
  await connectDb();
  const b = await PayrollBatch.findById(id).lean<IPayrollBatch>();
  if (!b) throw new PayrollError("Payroll batch not found.", 404);
  return b;
}

/* ----------------------------- post-change effects ----------------------------- */

async function syncBatchExceptionTask(batchId: string) {
  const b = await PayrollBatch.findById(batchId).lean<IPayrollBatch>();
  if (!b) return;
  const failed = b.status === "failed";
  const mismatch = b.status === "processed" && b.reconciliation?.status === "mismatch";
  const keyBase = `payroll:batch:${b._id}:exception`;
  if (failed || mismatch) {
    const refKey = failed ? `${keyBase}:failed:${b.version}` : `${keyBase}:mismatch:${b.reconciliation?.at ? new Date(b.reconciliation.at).getTime() : 0}`;
    await upsertSystemTask({
      candidateId: null,
      kind: "payroll",
      category: "payroll",
      refKey,
      title: failed
        ? `Payroll failed — ${b.payPeriod.start} to ${b.payPeriod.end}`
        : `Payroll reconciliation mismatch — ${b.payPeriod.start} to ${b.payPeriod.end}`,
      description: failed
        ? `Gusto payroll ${b.externalRef ?? "(no reference)"} failed${b.failureReason ? `: ${b.failureReason}` : ""}. Review and re-submit or void.`
        : "Register, provider report and settlement totals do not agree. Review the reconciliation and correct via a linked adjustment.",
      dueDate: todayIn("UTC"),
      ownerId: b.preparedBy,
      priority: "urgent",
      meta: { batchId: b._id, exception: failed ? "failed" : "mismatch" },
    });
  }
  // close exception tasks that no longer apply (never delete)
  const stale = new RegExp(`^${keyBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`);
  const keep = failed ? `${keyBase}:failed:${b.version}` : mismatch ? `${keyBase}:mismatch:${b.reconciliation?.at ? new Date(b.reconciliation.at).getTime() : 0}` : null;
  await Task.updateMany(
    { candidateId: null, refKey: { $regex: stale, ...(keep ? { $ne: keep } : {}) }, status: { $in: OPEN_TASK_STATUSES }, source: "system" },
    { $set: { status: "cancelled", cancelledReason: "Payroll exception no longer applies." } },
  );
}

/** Call after ANY change to a batch's status or reconciliation. */
export async function afterBatchChange(batchId: string, ctx: Ctx = {}) {
  await syncEmergencyItems(batchId, { actor: ctx.actor ?? null, source: ctx.source === "ui" ? "ui" : ctx.source });
  await syncBatchExceptionTask(batchId);
}

/* -------------------------------- transitions -------------------------------- */

interface TransitionOpts extends Ctx {
  set?: Record<string, unknown>;
  push?: Record<string, unknown>;
  addEditor?: string;
  summary: string;
  reason?: string;
  auditAction?: "status_change" | "approve" | "reject";
}

/** The ONLY place a batch status is written. Validates with canTransitionPayroll and is optimistic-concurrency safe. */
export async function applyTransition(batchId: string, to: PayrollStatus, o: TransitionOpts): Promise<IPayrollBatch> {
  const b = await loadBatch(batchId);
  if (b.status === "processed" && to === "voided") {
    throw new PayrollError("Processed payroll can never be voided or deleted. Create a linked correction (adjustment) batch instead.", 409, "processed_immutable");
  }
  try {
    assertPayrollTransition(b.status, to);
  } catch {
    throw new PayrollError(`A ${b.status.replace("_", " ")} batch cannot move to ${to.replace("_", " ")}.`, 409, "invalid_transition");
  }
  const update: Record<string, unknown> = { $set: { status: to, ...(o.set ?? {}) } };
  if (o.push) update.$push = o.push;
  if (o.addEditor) update.$addToSet = { editorIds: { $each: [b.preparedBy, o.addEditor] } };
  let res;
  try {
    res = await PayrollBatch.updateOne({ _id: batchId, status: b.status, version: b.version }, update);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new PayrollError("Another batch already uses this Gusto payroll ID.", 409, "duplicate_external_ref");
    throw err;
  }
  if (res.modifiedCount === 0) throw new PayrollError("The batch changed while you were working. Reload and try again.", 409, "conflict");
  await audit({
    actor: o.actor ?? null,
    source: o.source ?? (o.actor ? "ui" : "system"),
    action: o.auditAction ?? "status_change",
    entityType: "payroll_batch",
    entityId: batchId,
    summary: o.summary,
    reason: o.reason,
    before: { status: b.status },
    after: { status: to },
  });
  await afterBatchChange(batchId, o);
  return loadBatch(batchId);
}

/**
 * Register a CONTENT edit: only editable statuses; records the editor (they can never approve — AC-11); bumps
 * `version`; an edit to an approved/failed batch resets it to Needs Review and voids the approval.
 */
export async function registerEdit(actor: SessionUser, batchId: string, summary: string, ctx: Ctx = { source: "ui" }): Promise<IPayrollBatch> {
  const b = await loadBatch(batchId);
  if (!canEditBatch(b.status)) {
    throw new PayrollError(
      b.status === "processed"
        ? "Processed payroll cannot be edited. Create a linked correction (adjustment) batch."
        : `A ${b.status} batch cannot be edited.`,
      409,
      "not_editable",
    );
  }
  const next = statusAfterEdit(b.status);
  const reset = next !== b.status;
  const set: Record<string, unknown> = { status: next };
  if (reset) Object.assign(set, { approvedBy: null, approvedAt: null, approvedVersion: null });
  const update: Record<string, unknown> = {
    $set: set,
    $addToSet: { editorIds: { $each: [b.preparedBy, actor.id] } },
    $inc: { version: 1 },
  };
  if (b.status === "approved") update.$push = { approvalHistory: { action: "approval_reset", by: actor.id, at: new Date(), reason: summary, version: b.version } };
  const res = await PayrollBatch.updateOne({ _id: batchId, status: b.status, version: b.version }, update);
  if (res.modifiedCount === 0) throw new PayrollError("The batch changed while you were working. Reload and try again.", 409, "conflict");
  if (reset) {
    await audit({
      actor, source: ctx.source ?? "ui", action: "status_change", entityType: "payroll_batch", entityId: batchId,
      summary: `Edit after ${b.status} reset the batch to Needs Review — fresh approval by a different person is required (${summary})`,
      before: { status: b.status }, after: { status: next },
    });
    await afterBatchChange(batchId, { actor, source: ctx.source });
  }
  return loadBatch(batchId);
}

export async function recomputeTotals(batchId: string) {
  const items = await PayrollItem.find({ batchId }).lean<IPayrollItem[]>();
  const totals = computeTotals(items);
  await PayrollBatch.updateOne({ _id: batchId }, { $set: { totals } });
  return totals;
}

/* ----------------------------------- create ----------------------------------- */

export const createBatchSchema = z
  .object({
    payPeriod: z.object({ start: dateOnly, end: dateOnly, payDate: dateOnly }),
    companyRef: refField.optional().or(z.literal("")),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.payPeriod.end >= v.payPeriod.start, { message: "The pay period end cannot be before its start.", path: ["payPeriod"] });
export type CreateBatchInput = z.input<typeof createBatchSchema>;

export async function createBatch(actor: SessionUser, raw: CreateBatchInput) {
  assertCan(actor, "payroll.prepare");
  const input = createBatchSchema.parse(raw);
  await connectDb();
  const gusto = await getSetting("integrations.gusto");
  const created = await PayrollBatch.create({
    provider: "gusto",
    companyRef: input.companyRef || gusto.companyRef || undefined,
    payPeriod: input.payPeriod,
    kind: "regular",
    status: "draft",
    preparedBy: actor.id,
    editorIds: [actor.id],
    notes: input.notes,
    reconciliation: { status: "pending" },
  });
  await audit({
    actor, action: "create", entityType: "payroll_batch", entityId: created._id,
    summary: `Created payroll batch for ${input.payPeriod.start} – ${input.payPeriod.end} (pay date ${input.payPeriod.payDate})`,
    after: { payPeriod: input.payPeriod, companyRef: created.companyRef, status: "draft" },
  });
  return created.toObject() as IPayrollBatch;
}

/** Corrections to processed payroll are LINKED adjustment batches — the processed record itself is never edited/deleted. */
export async function createCorrectionBatch(actor: SessionUser, batchId: string, reason: string) {
  assertCan(actor, "payroll.prepare");
  const why = z.string().trim().min(5, "A reason (min 5 characters) is required.").max(1000).parse(reason);
  const orig = await loadBatch(batchId);
  if (orig.status !== "processed") throw new PayrollError("Only processed payroll needs a correction batch; edit or void other batches directly.", 409);
  const created = await PayrollBatch.create({
    provider: "gusto",
    companyRef: orig.companyRef,
    payPeriod: orig.payPeriod,
    kind: "adjustment",
    adjustsBatchId: orig._id,
    adjustmentReason: why,
    status: "draft",
    preparedBy: actor.id,
    editorIds: [actor.id],
    reconciliation: { status: "pending" },
  });
  await audit({
    actor, action: "create", entityType: "payroll_batch", entityId: created._id,
    summary: `Created correction batch linked to processed batch ${orig._id}`, reason: why, after: { adjustsBatchId: orig._id },
  });
  return created.toObject() as IPayrollBatch;
}

/* ------------------------------ workflow actions ------------------------------ */

export async function submitForReview(actor: SessionUser, batchId: string) {
  assertCan(actor, "payroll.prepare");
  const b = await loadBatch(batchId);
  const count = await PayrollItem.countDocuments({ batchId, status: { $ne: "excluded" } });
  if (count === 0) throw new PayrollError("Add at least one payroll item before submitting for review.", 422);
  return applyTransition(batchId, "needs_review", {
    actor, source: "ui", addEditor: actor.id,
    set: { submittedAt: new Date(), rejection: null },
    summary: `Submitted payroll batch for review (version ${b.version})`,
  });
}

export async function rejectBatch(actor: SessionUser, batchId: string, reason: string) {
  assertCan(actor, "payroll.approve");
  const why = z.string().trim().min(5, "A reason (min 5 characters) is required.").max(1000).parse(reason);
  const b = await loadBatch(batchId);
  return applyTransition(batchId, "draft", {
    actor, source: "ui", auditAction: "reject",
    set: { rejection: { reason: why, by: actor.id, at: new Date() } },
    push: { approvalHistory: { action: "rejected", by: actor.id, at: new Date(), reason: why, version: b.version } },
    summary: "Rejected payroll batch for changes", reason: why,
  });
}

/** AC-11: anyone who prepared/edited the batch (before OR after an earlier approval) can never give final approval. */
export async function approveBatch(actor: SessionUser, batchId: string) {
  assertCan(actor, "payroll.approve");
  const b = await loadBatch(batchId);
  if (b.status !== "needs_review") throw new PayrollError("Only a batch in Needs Review can be approved.", 409, "not_in_review");
  assertPayrollApprover(actor.id, b.preparedBy, b.editorIds ?? []);
  const items = await PayrollItem.find({ batchId }).select("status exceptionFlags").lean<IPayrollItem[]>();
  const blockers = approvalBlockers(items);
  if (blockers.length) throw new PayrollError(blockers.join(" "), 409, "approval_blocked");
  return applyTransition(batchId, "approved", {
    actor, source: "ui", auditAction: "approve",
    set: { approvedBy: actor.id, approvedAt: new Date(), approvedVersion: b.version, rejection: null },
    push: { approvalHistory: { action: "approved", by: actor.id, at: new Date(), version: b.version } },
    summary: `Approved payroll batch (version ${b.version})`,
  });
}

export const submittedSchema = z.object({ externalRef: refField.optional().or(z.literal("")) });

/** A human records that the approved batch was submitted in Gusto (Processing). Provider confirmation comes later. */
export async function markSubmittedToProvider(actor: SessionUser, batchId: string, raw: z.input<typeof submittedSchema> = {}) {
  if (!can(actor, "payroll.prepare") && !can(actor, "payroll.approve")) throw new ForbiddenError();
  const input = submittedSchema.parse(raw);
  const b = await loadBatch(batchId);
  if (b.status === "approved" && b.approvedVersion !== b.version) {
    throw new PayrollError("The approval does not cover the current version of this batch.", 409);
  }
  return applyTransition(batchId, "processing", {
    actor, source: "ui",
    set: { submittedToProviderAt: new Date(), ...(input.externalRef ? { externalRef: input.externalRef } : {}) },
    summary: `Recorded submission to Gusto${input.externalRef ? ` (payroll ${input.externalRef})` : ""} — status Processing`,
  });
}

export const evidenceSchema = z.object({
  externalRef: refField.optional().or(z.literal("")),
  processedDate: dateOnly,
  payStatementRef: z.string().trim().max(128).optional().or(z.literal("")),
  note: z.string().trim().min(5, "Describe the provider evidence you reviewed (min 5 characters).").max(1000),
});

/**
 * `processed` via a HUMAN: requires payroll.reconcile or payroll.approve AND a provider reference (Gusto payroll ID)
 * plus a note of the evidence reviewed. Audited. Never callable with a browser-supplied "completed" flag alone.
 */
export async function recordProviderEvidence(actor: SessionUser, batchId: string, raw: z.input<typeof evidenceSchema>) {
  if (!can(actor, "payroll.reconcile") && !can(actor, "payroll.approve")) throw new ForbiddenError();
  const input = evidenceSchema.parse(raw);
  const b = await loadBatch(batchId);
  const ref = input.externalRef || b.externalRef;
  if (!ref) throw new PayrollError("A provider reference (Gusto payroll ID) is required to record processed payroll.", 422, "provider_ref_required");
  const plan = planWebhookTransitions(b.status, "processed");
  if (plan.action !== "apply") throw new PayrollError(plan.action === "noop" ? "This batch is already processed." : plan.reason, 409);

  const processedAt = new Date(`${input.processedDate}T12:00:00.000Z`);
  let latest = b;
  for (const step of plan.steps) {
    latest = await applyTransition(batchId, step, {
      actor, source: "ui",
      set:
        step === "processed"
          ? {
              externalRef: ref,
              processedAt,
              processedVia: "manual_evidence",
              processedBy: actor.id,
              providerEvidenceNote: input.note,
              payStatementRef: input.payStatementRef || undefined,
              reconciliation: { status: "pending" }, // Completed-Pending-Reconciliation until reconciled
            }
          : { externalRef: ref, submittedToProviderAt: new Date() },
      summary:
        step === "processed"
          ? `Recorded provider evidence: payroll ${ref} processed on ${input.processedDate}`
          : `Recorded submission to Gusto (payroll ${ref})`,
      reason: step === "processed" ? input.note : undefined,
    });
  }
  await logSync({ kind: "evidence", message: `Manual provider evidence recorded for Gusto payroll ${ref}`, batchId, actorId: actor.id, source: "ui" });
  return latest;
}

export async function markBatchFailed(actor: SessionUser, batchId: string, reason: string) {
  if (!can(actor, "payroll.prepare") && !can(actor, "payroll.approve") && !can(actor, "payroll.reconcile")) throw new ForbiddenError();
  const why = z.string().trim().min(5, "A reason (min 5 characters) is required.").max(1000).parse(reason);
  const res = await applyTransition(batchId, "failed", { actor, source: "ui", set: { failureReason: why }, summary: "Recorded payroll failure", reason: why });
  await logSync({ kind: "evidence", level: "warn", message: `Payroll recorded as failed: ${why}`, batchId, actorId: actor.id, source: "ui" });
  return res;
}

/** failed → needs_review so the preparer can fix and re-submit (a fresh approval is required). */
export async function reopenFailed(actor: SessionUser, batchId: string) {
  assertCan(actor, "payroll.prepare");
  return applyTransition(batchId, "needs_review", {
    actor, source: "ui", addEditor: actor.id,
    set: { approvedBy: null, approvedAt: null, approvedVersion: null, failureReason: null },
    summary: "Reopened failed payroll batch for correction (approval reset)",
  });
}

export async function voidBatch(actor: SessionUser, batchId: string, reason: string) {
  if (!can(actor, "payroll.prepare") && !can(actor, "payroll.approve")) throw new ForbiddenError();
  const why = z.string().trim().min(5, "A reason (min 5 characters) is required.").max(1000).parse(reason);
  return applyTransition(batchId, "voided", {
    actor, source: "ui",
    set: { voidedReason: why, voidedBy: actor.id, voidedAt: new Date() },
    summary: "Voided payroll batch", reason: why,
  });
}

/* ------------------------------ items ------------------------------ */

function money(label: string, v: unknown): number | null {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const c = parseMoneyToCents(v);
  if (c === null) throw new PayrollError(`Invalid ${label} amount. Use a number with up to 2 decimals.`, 422);
  return c;
}

/**
 * Idempotent upsert keyed by (batchId, externalEmployeeRef): update → create → retry-update, so the unique index
 * (not application timing) guarantees a re-import or double submit can never create a second row.
 */
export async function upsertItem(batchId: string, externalEmployeeRef: string, set: Record<string, unknown>, onInsert: Record<string, unknown>) {
  const filter = { batchId, externalEmployeeRef };
  const upd = await PayrollItem.updateOne(filter, { $set: set });
  if (upd.matchedCount > 0) return "updated" as const;
  try {
    await PayrollItem.create({ ...filter, ...set, ...onInsert });
    return "created" as const;
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    await PayrollItem.updateOne(filter, { $set: set });
    return "updated" as const;
  }
}

export const itemInputSchema = z.object({
  candidateId: z.string().min(1, "Choose a candidate."),
  hours: z.union([z.string(), z.number()]).optional().nullable(),
  payType: z.enum(PAY_TYPES).default("hourly"),
  gross: z.union([z.string(), z.number()]).optional().nullable(),
  net: z.union([z.string(), z.number()]).optional().nullable(),
  bonuses: z.union([z.string(), z.number()]).optional().nullable(),
  deductions: z.union([z.string(), z.number()]).optional().nullable(),
  adjustments: z.union([z.string(), z.number()]).optional().nullable(),
  adjustmentNote: z.string().trim().max(500).optional(),
});
export type ItemInput = z.input<typeof itemInputSchema>;

function hoursValue(v: unknown): number | null {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) > 744) throw new PayrollError("Hours must be a number between 0 and 744 (max 2 decimals).", 422);
  return Number(s);
}

export async function saveItem(actor: SessionUser, batchId: string, raw: ItemInput) {
  assertCan(actor, "payroll.prepare");
  assertCan(actor, "payroll.amounts.view"); // entering amounts requires seeing them
  const input = itemInputSchema.parse(raw);
  const candidate = await loadCandidateFor(actor, input.candidateId);
  if (!candidate) throw new PayrollError("Candidate not found.", 404);
  const mapping = candidate.payrollMapping;
  if (!mapping?.employeeId) throw new PayrollError("This candidate is not mapped to a Gusto employee. Map them first (Payroll → Candidate mapping).", 422, "unmapped");
  const batch = await loadBatch(batchId);
  if (batch.companyRef && mapping.companyRef && batch.companyRef !== mapping.companyRef) {
    throw new PayrollError("The candidate is mapped to a different Gusto company than this batch.", 422);
  }
  const hours = hoursValue(input.hours);
  const grossCents = money("gross", input.gross);
  const netCents = money("net", input.net);
  const flags = computeItemFlags({ payType: input.payType, hours, grossCents, netCents, matched: true });

  await registerEdit(actor, batchId, "Item added/updated");
  const existing = await PayrollItem.findOne({ batchId, externalEmployeeRef: mapping.employeeId }).lean<IPayrollItem>();
  if (existing?.status === "excluded") {
    throw new PayrollError("This item is excluded. Include it again before editing.", 409);
  }
  await upsertItem(
    batchId,
    mapping.employeeId,
    {
      candidateId: candidate._id,
      employeeName: candidate.legalName,
      hours, payType: input.payType, grossCents, netCents,
      bonusesCents: money("bonus", input.bonuses) ?? 0,
      deductionsCents: money("deduction", input.deductions) ?? 0,
      adjustmentsCents: money("adjustment", input.adjustments) ?? 0,
      adjustmentNote: input.adjustmentNote,
      exceptionFlags: flags,
      status: flags.length ? "flagged" : "ok",
      updatedBy: actor.id,
    },
    { kind: batch.kind, source: "manual", createdBy: actor.id },
  );
  await recomputeTotals(batchId);
  await audit({
    actor, action: existing ? "update" : "create", entityType: "payroll_item", entityId: batchId, candidateId: candidate._id,
    summary: `${existing ? "Updated" : "Added"} payroll item (hours ${hours ?? "n/a"}, ${input.payType}; amounts not logged)`,
    after: { payType: input.payType, hours, exceptionFlags: flags },
  });
  await linkEmergencyForCandidates(batchId, [candidate._id], { actor, source: "ui" });
}

export async function setItemExcluded(actor: SessionUser, batchId: string, itemId: string, p: { exclude: boolean; reason?: string }) {
  assertCan(actor, "payroll.prepare");
  const item = await PayrollItem.findOne({ _id: itemId, batchId }).lean<IPayrollItem>();
  if (!item) throw new PayrollError("Payroll item not found.", 404);
  if (p.exclude && (!p.reason || p.reason.trim().length < 5)) throw new PayrollError("A reason (min 5 characters) is required to exclude an item.", 422);
  await registerEdit(actor, batchId, p.exclude ? "Item excluded" : "Item included");
  if (p.exclude) {
    await PayrollItem.updateOne({ _id: itemId }, { $set: { status: "excluded", excludedReason: p.reason!.trim(), updatedBy: actor.id } });
  } else {
    const flags = computeItemFlags({ payType: item.payType, hours: item.hours, grossCents: item.grossCents, netCents: item.netCents, matched: !!item.candidateId });
    await PayrollItem.updateOne({ _id: itemId }, { $set: { status: flags.length ? "flagged" : "ok", exceptionFlags: flags, updatedBy: actor.id }, $unset: { excludedReason: "" } });
  }
  await recomputeTotals(batchId);
  await audit({
    actor, action: "update", entityType: "payroll_item", entityId: batchId, candidateId: item.candidateId,
    summary: p.exclude ? "Excluded payroll item from batch" : "Re-included payroll item", reason: p.exclude ? p.reason : undefined,
  });
}

/** Draft rows may be removed; once a batch is processed nothing is ever deleted (registerEdit refuses). */
export async function removeItem(actor: SessionUser, batchId: string, itemId: string) {
  assertCan(actor, "payroll.prepare");
  const item = await PayrollItem.findOne({ _id: itemId, batchId }).lean<IPayrollItem>();
  if (!item) throw new PayrollError("Payroll item not found.", 404);
  await registerEdit(actor, batchId, "Item removed");
  await PayrollItem.deleteOne({ _id: itemId, batchId });
  await recomputeTotals(batchId);
  await audit({ actor, action: "delete", entityType: "payroll_item", entityId: batchId, candidateId: item.candidateId, summary: "Removed item from unprocessed payroll batch" });
}

/* ---------------------------- reconciliation ---------------------------- */

export const reconcileSchema = z.object({
  providerTotal: z.union([z.string(), z.number()]).optional().nullable(),
  settlementTotal: z.union([z.string(), z.number()]).optional().nullable(),
  settlementReference: z.string().trim().max(128).optional().or(z.literal("")),
  note: z.string().trim().max(1000).optional(),
});
export type ReconcileFormInput = z.input<typeof reconcileSchema>;

/**
 * Compare the CRM register total (net pay) with the provider report total and the actual settlement/bank amount.
 * Any difference ⇒ `mismatch` ⇒ exception task + the emergency item flips to Action Required. Only for Processed batches.
 */
export async function reconcileBatch(actor: SessionUser, batchId: string, raw: ReconcileFormInput) {
  assertCan(actor, "payroll.reconcile");
  assertCan(actor, "payroll.amounts.view");
  const input = reconcileSchema.parse(raw);
  const b = await loadBatch(batchId);
  if (b.status !== "processed") throw new PayrollError("Only processed payroll can be reconciled.", 409);
  const providerCents = money("provider total", input.providerTotal);
  const settlementCents = money("settlement", input.settlementTotal);
  const registerCents = b.totals?.netCents ?? 0;
  const result = reconcileTotals({ registerCents, providerCents, settlementCents, settlementReference: input.settlementReference });

  const rec = {
    status: result.status,
    by: actor.id,
    at: new Date(),
    note: input.note,
    settlementReference: input.settlementReference || undefined,
    differenceCents: result.differenceCents,
    registerTotalCents: registerCents,
    providerTotalCents: providerCents,
    settlementTotalCents: settlementCents,
  };
  const res = await PayrollBatch.updateOne({ _id: batchId, status: "processed" }, { $set: { reconciliation: rec } });
  if (res.modifiedCount === 0) throw new PayrollError("The batch changed while you were working. Reload and try again.", 409);
  await audit({
    actor, action: "status_change", entityType: "payroll_batch", entityId: batchId,
    summary: `Reconciliation ${b.reconciliation?.status ?? "pending"} → ${result.status}${result.reasons.length ? ` (${result.reasons.join(" ")})` : ""}`,
    reason: input.note, before: { reconciliation: b.reconciliation?.status ?? "pending" }, after: { reconciliation: result.status, settlementReference: rec.settlementReference },
  });
  await logSync({
    kind: "reconcile", level: result.status === "mismatch" ? "warn" : "info", batchId, actorId: actor.id, source: "ui",
    message: `Reconciliation ${result.status}${result.reasons.length ? `: ${result.reasons.join(" ")}` : ""}`,
  });
  await afterBatchChange(batchId, { actor, source: "ui" });
  return { batch: await loadBatch(batchId), result };
}
