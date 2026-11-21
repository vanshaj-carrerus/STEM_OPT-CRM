import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { audit } from "@/lib/audit";
import { assertCan, can, type Actor } from "@/lib/rbac/can";
import { assertOverrideApprover } from "@/lib/sod";
import { loadCandidateFor } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { isDateOnly, todayIn } from "@/lib/compliance/dates";
import { upsertSystemTask, cancelSystemTasks } from "@/lib/tasks/core";
import { Notification } from "@/lib/db/models/notification";
import { User } from "@/lib/db/models/user";
import { PayrollBatch, type IPayrollBatch } from "@/lib/db/models/payroll-batch";
import { EmergencyPayrollItem, type IEmergencyPayrollItem, type IEmergencyHistory } from "@/lib/db/models/emergency-payroll-item";
import { isActiveEmergency, type EmergencyStatus } from "./rules";
import { actionRequiredReason, deriveItemStatus, overrideAllowed, resolutionCheck, type BatchState } from "./emergency-logic";
import { PayrollError } from "./errors";

/**
 * Emergency payroll queue service. The queue is a TEMPORARY FLAG, not a permanent candidate status:
 * every status is computed by `deriveItemStatus` (→ foundation `deriveEmergencyStatus`) inside ONE function,
 * `syncEmergencyItems(batchId)`, which every payroll mutation (status change, evidence, webhook, reconciliation,
 * import) calls — so an item can never drift from its batch.
 */

export interface SyncCtx {
  actor?: (Actor & { email?: string }) | null;
  source?: "ui" | "api" | "worker" | "webhook" | "system";
}

const dateOnly = z.string().refine(isDateOnly, "Use a valid date (YYYY-MM-DD).");

export const flagEmergencySchema = z.object({
  candidateId: z.string().min(1),
  reason: z.string().trim().min(5, "Describe why this is an emergency (min 5 characters).").max(1000),
  requestedPayDate: dateOnly,
  ownerId: z.string().min(1).optional().nullable(),
  priority: z.enum(["normal", "high", "urgent"]).default("high"),
  batchId: z.string().min(1).optional().nullable(),
});
export type FlagEmergencyInput = z.input<typeof flagEmergencySchema>;

const today = () => todayIn("UTC");

function batchState(b: Pick<IPayrollBatch, "status" | "reconciliation" | "rejection"> | null | undefined): BatchState | null {
  if (!b) return null;
  return { status: b.status, reconciliation: b.reconciliation?.status ?? "pending", rejected: b.status === "draft" && !!b.rejection };
}

async function requireReviewer() {
  return (await getSetting("emergencyPayroll.requireReviewer")) !== false;
}

/* ----------------------------- re-derivation ----------------------------- */

async function ensureActionRequired(item: IEmergencyPayrollItem, reason: string | null, firstTime: boolean) {
  const title = `Emergency payroll action required — ${reason ?? "review needed"}`;
  await upsertSystemTask({
    candidateId: item.candidateId,
    kind: "payroll",
    category: "payroll",
    refKey: `payroll:emergency:${item._id}:action`,
    title,
    description: `${item.reason}\nPay deadline: ${item.requestedPayDate}. Payroll state: ${reason ?? "n/a"}.`,
    dueDate: today(),
    ownerId: item.ownerId,
    priority: "urgent",
    meta: { emergencyItemId: item._id, batchId: item.batchId ?? null },
  });
  if (!firstTime) return;
  const recipients = [...new Set([item.ownerId, item.requestedBy].filter(Boolean) as string[])];
  for (const userId of recipients) {
    await Notification.create({
      userId,
      title: "Emergency payroll needs action",
      body: `${reason ?? "Review needed"} — pay deadline ${item.requestedPayDate}.`,
      link: `/emergency-payroll/${item._id}`,
      kind: "escalation",
    });
  }
}

async function clearActionRequired(item: IEmergencyPayrollItem, why: string) {
  await cancelSystemTasks(item.candidateId, `payroll:emergency:${item._id}:action`, why);
}

/** Re-derive ONE item from its batch and persist any change (+ side effects). Idempotent. */
async function reDerive(item: IEmergencyPayrollItem, batch: IPayrollBatch | null, needReviewer: boolean, ctx: SyncCtx): Promise<IEmergencyPayrollItem> {
  const bs = batchState(batch);
  let reviewerConfirmed = item.reviewerConfirmed;
  // A reviewer confirmation applies to the evidence they saw: if reconciliation is no longer "reconciled" it lapses.
  if (reviewerConfirmed && bs?.reconciliation !== "reconciled") reviewerConfirmed = false;

  const next = deriveItemStatus({ reviewerConfirmed, override: item.override }, bs, { requireReviewer: needReviewer });
  const reason = next === "action_required" ? actionRequiredReason(bs) : null;
  const changed = next !== item.status || reviewerConfirmed !== item.reviewerConfirmed || (next === "action_required" && item.actionReason !== reason);

  if (next === "action_required") {
    await ensureActionRequired(item, reason, item.status !== "action_required");
  } else if (item.status === "action_required") {
    await clearActionRequired(item, `Emergency payroll state is now ${next}.`);
  }
  if (!changed) return item;

  const now = new Date();
  const history: IEmergencyHistory[] = [];
  if (next !== item.status) {
    history.push({ at: now, by: ctx.actor?.id ?? null, action: "status_change", fromStatus: item.status, toStatus: next, note: reason ?? undefined });
  }
  const enteringAction = next === "action_required" && item.status !== "action_required";
  if (enteringAction) {
    history.push({ at: now, by: null, action: "escalated", note: "Owner notified and exception task created; item escalated for review." });
  }
  const set: Record<string, unknown> = {
    status: next,
    isActive: isActiveEmergency(next),
    actionRequired: next === "action_required",
    actionReason: reason,
    reviewerConfirmed,
  };
  if (!reviewerConfirmed) Object.assign(set, { reviewerConfirmedBy: null, reviewerConfirmedAt: null });
  if (enteringAction) Object.assign(set, { escalationLevel: Math.max(1, item.escalationLevel), escalatedAt: now });
  if (next === "resolved" || next === "removed") {
    const via: IEmergencyPayrollItem["resolvedVia"] =
      next === "removed" ? "removal" : item.override?.status === "approved" && item.override.kind === "exception" ? "exception" : "reconciliation";
    Object.assign(set, { resolvedAt: now, resolvedVia: via });
  }

  const res = await EmergencyPayrollItem.updateOne({ _id: item._id, status: item.status }, { $set: set, ...(history.length ? { $push: { history: { $each: history } } } : {}) });
  if (res.modifiedCount === 0) {
    // lost a race with another sync — the winner already derived from the same inputs; re-read and return
    return (await EmergencyPayrollItem.findById(item._id).lean<IEmergencyPayrollItem>()) ?? item;
  }
  if (next !== item.status) {
    await audit({
      actor: ctx.actor ?? null,
      source: ctx.source ?? (ctx.actor ? "ui" : "system"),
      action: "status_change",
      entityType: "emergency_payroll_item",
      entityId: item._id,
      candidateId: item.candidateId,
      summary: `Emergency payroll ${item.status} → ${next}${reason ? ` (${reason})` : ""}`,
      before: { status: item.status },
      after: { status: next, batchStatus: bs?.status, reconciliation: bs?.reconciliation },
    });
  }
  return (await EmergencyPayrollItem.findById(item._id).lean<IEmergencyPayrollItem>()) ?? item;
}

/** THE single re-derivation entry point: call after ANY change to a batch's state or reconciliation. */
export async function syncEmergencyItems(batchId: string, ctx: SyncCtx = {}): Promise<void> {
  await connectDb();
  const batch = await PayrollBatch.findById(batchId).lean<IPayrollBatch>();
  if (!batch) return;
  const items = await EmergencyPayrollItem.find({ batchId, isActive: true }).lean<IEmergencyPayrollItem[]>();
  if (!items.length) return;
  const need = await requireReviewer();
  for (const it of items) await reDerive(it, batch, need, ctx);
}

/** Re-derive one item (after an override decision, a link change, ...). */
export async function syncEmergencyItem(itemId: string, ctx: SyncCtx = {}): Promise<IEmergencyPayrollItem | null> {
  await connectDb();
  const item = await EmergencyPayrollItem.findById(itemId).lean<IEmergencyPayrollItem>();
  if (!item) return null;
  const batch = item.batchId ? await PayrollBatch.findById(item.batchId).lean<IPayrollBatch>() : null;
  return reDerive(item, batch, await requireReviewer(), ctx);
}

/* --------------------------------- flagging --------------------------------- */

export async function flagEmergency(actor: SessionUser, raw: FlagEmergencyInput) {
  assertCan(actor, "emergency.manage");
  const input = flagEmergencySchema.parse(raw);
  const candidate = await loadCandidateFor(actor, input.candidateId);
  if (!candidate) throw new PayrollError("Candidate not found.", 404);
  await connectDb();

  let batch: IPayrollBatch | null = null;
  if (input.batchId) {
    batch = await PayrollBatch.findById(input.batchId).lean<IPayrollBatch>();
    if (!batch) throw new PayrollError("Payroll batch not found.", 404);
  }
  const ownerId = input.ownerId || actor.id;
  if (!(await User.exists({ _id: ownerId, active: true }))) throw new PayrollError("The selected owner is not an active user.", 422);

  let created;
  try {
    created = await EmergencyPayrollItem.create({
      candidateId: input.candidateId,
      reason: input.reason,
      requestedPayDate: input.requestedPayDate,
      ownerId,
      priority: input.priority,
      batchId: batch?._id ?? null,
      payrollPeriod: batch ? { start: batch.payPeriod.start, end: batch.payPeriod.end } : null,
      status: "open",
      isActive: true,
      requestedBy: actor.id,
      history: [{ at: new Date(), by: actor.id, action: "flagged", toStatus: "open", note: input.reason }],
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new PayrollError("This candidate already has an active emergency payroll item.", 409, "duplicate_active");
    throw err;
  }
  await audit({
    actor, action: "create", entityType: "emergency_payroll_item", entityId: created._id, candidateId: input.candidateId,
    summary: `Flagged emergency payroll (pay deadline ${input.requestedPayDate})`,
    after: { reason: input.reason, requestedPayDate: input.requestedPayDate, ownerId, priority: input.priority, batchId: batch?._id ?? null },
  });
  return (await syncEmergencyItem(created._id, { actor }))!;
}

async function loadActive(id: string): Promise<IEmergencyPayrollItem> {
  await connectDb();
  const item = await EmergencyPayrollItem.findById(id).lean<IEmergencyPayrollItem>();
  if (!item) throw new PayrollError("Emergency payroll item not found.", 404);
  return item;
}

async function assertCandidateAccess(actor: SessionUser, item: IEmergencyPayrollItem) {
  if (!(await loadCandidateFor(actor, item.candidateId))) throw new PayrollError("Emergency payroll item not found.", 404);
}

export const updateEmergencySchema = z.object({
  reason: z.string().trim().min(5).max(1000).optional(),
  requestedPayDate: dateOnly.optional(),
  ownerId: z.string().min(1).optional(),
  priority: z.enum(["normal", "high", "urgent"]).optional(),
});

export async function updateEmergency(actor: SessionUser, id: string, raw: z.input<typeof updateEmergencySchema>) {
  assertCan(actor, "emergency.manage");
  const patch = updateEmergencySchema.parse(raw);
  const item = await loadActive(id);
  await assertCandidateAccess(actor, item);
  if (!item.isActive) throw new PayrollError("Resolved items are read-only history.", 409);
  if (patch.ownerId && !(await User.exists({ _id: patch.ownerId, active: true }))) throw new PayrollError("The selected owner is not an active user.", 422);
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(set).length) return item;
  await EmergencyPayrollItem.updateOne({ _id: id }, { $set: set, $push: { history: { at: new Date(), by: actor.id, action: "updated", note: Object.keys(set).join(", ") } } });
  await audit({ actor, action: "update", entityType: "emergency_payroll_item", entityId: id, candidateId: item.candidateId, summary: `Updated emergency payroll (${Object.keys(set).join(", ")})`, before: Object.fromEntries(Object.keys(set).map((k) => [k, (item as unknown as Record<string, unknown>)[k]])), after: set });
  return (await EmergencyPayrollItem.findById(id).lean<IEmergencyPayrollItem>())!;
}

export async function linkEmergencyToBatch(actor: SessionUser, id: string, batchId: string) {
  if (!can(actor, "emergency.manage") && !can(actor, "payroll.prepare")) assertCan(actor, "emergency.manage");
  const item = await loadActive(id);
  await assertCandidateAccess(actor, item);
  if (!item.isActive) throw new PayrollError("Resolved items are read-only history.", 409);
  const batch = await PayrollBatch.findById(batchId).lean<IPayrollBatch>();
  if (!batch) throw new PayrollError("Payroll batch not found.", 404);
  if (item.batchId && item.batchId !== batchId) {
    const current = await PayrollBatch.findById(item.batchId).select("status").lean<IPayrollBatch>();
    if (current && (current.status === "processing" || current.status === "processed")) {
      throw new PayrollError("The linked payroll is already submitted/processed; the link cannot be changed.", 409);
    }
  }
  await EmergencyPayrollItem.updateOne(
    { _id: id },
    { $set: { batchId, payrollPeriod: { start: batch.payPeriod.start, end: batch.payPeriod.end } }, $push: { history: { at: new Date(), by: actor.id, action: "linked", note: `Linked to batch ${batch.payPeriod.start} – ${batch.payPeriod.end}` } } },
  );
  await audit({ actor, action: "update", entityType: "emergency_payroll_item", entityId: id, candidateId: item.candidateId, summary: "Linked emergency payroll to batch", before: { batchId: item.batchId ?? null }, after: { batchId } });
  return syncEmergencyItem(id, { actor });
}

/** Called by batch mutations: when a candidate with an unlinked ACTIVE emergency item is added to a batch, link it. */
export async function linkEmergencyForCandidates(batchId: string, candidateIds: string[], ctx: SyncCtx = {}) {
  if (!candidateIds.length) return;
  await connectDb();
  const batch = await PayrollBatch.findById(batchId).lean<IPayrollBatch>();
  if (!batch) return;
  const items = await EmergencyPayrollItem.find({ candidateId: { $in: candidateIds }, isActive: true, batchId: null }).lean<IEmergencyPayrollItem[]>();
  for (const it of items) {
    await EmergencyPayrollItem.updateOne(
      { _id: it._id, batchId: null },
      { $set: { batchId, payrollPeriod: { start: batch.payPeriod.start, end: batch.payPeriod.end } }, $push: { history: { at: new Date(), by: ctx.actor?.id ?? null, action: "linked", note: "Candidate added to payroll batch." } } },
    );
  }
  await syncEmergencyItems(batchId, ctx);
}

/* ------------------------- overrides (exception / manual removal) ------------------------- */

export const overrideRequestSchema = z.object({
  kind: z.enum(["exception", "removal"]),
  reason: z.string().trim().min(5, "A mandatory reason (min 5 characters) is required.").max(1000),
});

export async function requestOverride(actor: SessionUser, id: string, raw: z.input<typeof overrideRequestSchema>) {
  if (!can(actor, "emergency.manage") && !can(actor, "emergency.override")) assertCan(actor, "emergency.manage");
  const input = overrideRequestSchema.parse(raw);
  const item = await loadActive(id);
  await assertCandidateAccess(actor, item);
  if (!item.isActive) throw new PayrollError("This item is already resolved.", 409);
  if (item.override?.status === "pending") throw new PayrollError("An override request is already awaiting manager approval.", 409);
  const override = { kind: input.kind, reason: input.reason, requestedBy: actor.id, requestedAt: new Date(), status: "pending" as const };
  await EmergencyPayrollItem.updateOne(
    { _id: id },
    { $set: { override }, $push: { history: { at: new Date(), by: actor.id, action: "override_requested", note: `${input.kind}: ${input.reason}` } } },
  );
  await audit({ actor, action: "create", entityType: "emergency_payroll_override", entityId: id, candidateId: item.candidateId, summary: `Requested ${input.kind === "removal" ? "manual removal" : "approved exception"} for emergency payroll`, reason: input.reason });
  return (await EmergencyPayrollItem.findById(id).lean<IEmergencyPayrollItem>())!;
}

export const overrideDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).optional(),
});

export async function decideOverride(actor: SessionUser, id: string, raw: z.input<typeof overrideDecisionSchema>) {
  assertCan(actor, "emergency.override");
  const input = overrideDecisionSchema.parse(raw);
  const item = await loadActive(id);
  await assertCandidateAccess(actor, item);
  const o = item.override;
  if (!o || o.status !== "pending") throw new PayrollError("There is no pending override request.", 409);
  assertOverrideApprover(actor.id, o.requestedBy); // approver ≠ requester (AC-10)
  if (input.decision === "approve") {
    const v = overrideAllowed({ reason: o.reason, requesterId: o.requestedBy, approverId: actor.id });
    if (!v.ok) throw new PayrollError(v.error, 422);
  }
  const status = input.decision === "approve" ? "approved" : "rejected";
  const res = await EmergencyPayrollItem.updateOne(
    { _id: id, "override.status": "pending" },
    {
      $set: { "override.status": status, "override.decidedBy": actor.id, "override.decidedAt": new Date(), "override.decisionNote": input.note },
      $push: { history: { at: new Date(), by: actor.id, action: input.decision === "approve" ? "override_approved" : "override_rejected", note: input.note ?? o.reason } },
    },
  );
  if (res.modifiedCount === 0) throw new PayrollError("The override was already decided.", 409);
  await audit({
    actor, action: input.decision === "approve" ? "approve" : "reject", entityType: "emergency_payroll_override", entityId: id, candidateId: item.candidateId,
    summary: `${input.decision === "approve" ? "Approved" : "Rejected"} ${o.kind === "removal" ? "manual removal" : "exception"} (requested by another user)`,
    reason: o.reason, after: { kind: o.kind, requestedBy: o.requestedBy, decision: status },
  });
  return (await syncEmergencyItem(id, { actor }))!;
}

/* ----------------------------------- resolve ----------------------------------- */

/**
 * Resolve only when completion + reconciliation (+ reviewer confirmation) hold. The acting user with
 * `emergency.resolve` IS the reviewer confirmation. Otherwise throws 409 carrying the reason from `canResolveEmergency`.
 */
export async function resolveEmergency(actor: SessionUser, id: string, raw: { note?: string } = {}) {
  assertCan(actor, "emergency.resolve");
  const item = await loadActive(id);
  await assertCandidateAccess(actor, item);
  if (!item.isActive) return item; // already resolved — idempotent
  const batch = item.batchId ? await PayrollBatch.findById(item.batchId).lean<IPayrollBatch>() : null;
  const need = await requireReviewer();
  const check = resolutionCheck({ reviewerConfirmed: item.reviewerConfirmed, override: item.override }, batchState(batch), { requireReviewer: need });
  if (!check.ok) throw new PayrollError(check.reason ?? "Item cannot be resolved.", 409, "not_resolvable");

  const note = raw.note?.trim().slice(0, 1000);
  await EmergencyPayrollItem.updateOne(
    { _id: id, isActive: true },
    {
      $set: { reviewerConfirmed: true, reviewerConfirmedBy: actor.id, reviewerConfirmedAt: new Date(), reviewerNote: note },
      $push: { history: { at: new Date(), by: actor.id, action: "reviewer_confirmed", note: note ?? "Settlement evidence confirmed." } },
    },
  );
  await audit({ actor, action: "approve", entityType: "emergency_payroll_item", entityId: id, candidateId: item.candidateId, summary: "Reviewer confirmed payroll settlement for emergency item", reason: note });
  const updated = (await syncEmergencyItem(id, { actor }))!;
  if (updated.isActive) throw new PayrollError("Item cannot be resolved.", 409, "not_resolvable");
  return updated;
}

/* ----------------------------- escalation (worker) ----------------------------- */

/** For the worker/cron: bump the escalation level of Action-Required items untouched for 24h (max level 3). */
export async function escalateStaleEmergencies(now = new Date(), ctx: SyncCtx = { source: "worker" }) {
  await connectDb();
  const cutoff = new Date(now.getTime() - 24 * 3600_000);
  const stale = await EmergencyPayrollItem.find({ isActive: true, actionRequired: true, escalationLevel: { $lt: 3 }, escalatedAt: { $lte: cutoff } }).lean<IEmergencyPayrollItem[]>();
  let n = 0;
  for (const it of stale) {
    const level = it.escalationLevel + 1;
    const res = await EmergencyPayrollItem.updateOne(
      { _id: it._id, escalationLevel: it.escalationLevel },
      { $set: { escalationLevel: level, escalatedAt: now }, $push: { history: { at: now, by: null, action: "escalated", note: `Still Action Required after 24h — escalation level ${level}.` } } },
    );
    if (res.modifiedCount) {
      n++;
      await audit({ actor: ctx.actor ?? null, source: ctx.source ?? "worker", action: "system", entityType: "emergency_payroll_item", entityId: it._id, candidateId: it.candidateId, summary: `Escalated emergency payroll to level ${level}` });
    }
  }
  return n;
}

export type { EmergencyStatus };
