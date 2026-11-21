import { connectDb } from "@/lib/db/connect";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { AuthorizationPeriod, type IAuthorizationPeriod } from "@/lib/db/models/employer";
import { Task } from "@/lib/db/models/task";
import { AUTH_TYPE_LABELS } from "@/lib/candidates/constants";
import { cancelSystemTasks, refreshCandidateNextDue, upsertSystemTask } from "@/lib/tasks/core";
import type { SessionUser } from "@/lib/auth/session";
import type { DateOnly } from "@/lib/compliance/dates";
import { todayFor } from "./calendar";
import { enforceClearance } from "./clearance-service";
import { getEvidenceDocs } from "./evidence";
import { isEffectivelyVerified, refreshRiskFlags } from "./flags";
import { buildDesiredMilestones, MILESTONE_REF_PREFIX, planMilestones, type ExistingMilestoneTask } from "./milestone-plan";

export interface ScheduleResult {
  created: number;
  updated: number;
  reopened: number;
  cancelled: number;
  clearanceRevoked: boolean;
}

export const OBSOLETE_MILESTONE_REASON = "Authorization date was corrected, un-verified or removed; this milestone no longer applies.";

/**
 * Re-derive compliance milestones for a candidate from VERIFIED authorization periods only, diff against the
 * existing tasks (completed history is preserved, obsolete open tasks are cancelled never deleted), then
 * re-check clearance, refresh immigration risk flags and the candidate's denormalised next-due date.
 * Idempotent: safe to call after every relevant edit and from the daily worker.
 */
export async function regenerateSchedule(args: { actor: SessionUser | null; candidateId: string; today?: DateOnly }): Promise<ScheduleResult> {
  const { actor, candidateId } = args;
  const today = args.today ?? todayFor(actor);
  const result: ScheduleResult = { created: 0, updated: 0, reopened: 0, cancelled: 0, clearanceRevoked: false };
  await connectDb();
  const candidate = await Candidate.findById(candidateId).select("ownerId authType").lean<ICandidate>();
  if (!candidate) return result;

  const periods = await AuthorizationPeriod.find({ candidateId }).lean<IAuthorizationPeriod[]>();
  const docs = await getEvidenceDocs(candidateId, periods.map((p) => p.evidenceDocumentId));
  const verified = periods.filter((p) => isEffectivelyVerified(p, docs));
  const desired = buildDesiredMilestones(
    verified.map((p) => ({ id: p._id, type: p.type, startDate: p.startDate, endDate: p.endDate })),
    today,
  );

  const existingRows = await Task.find({ candidateId, kind: "milestone", refKey: { $regex: `^${MILESTONE_REF_PREFIX}` } })
    .select("refKey status dueDate snoozes")
    .lean<{ refKey: string; status: ExistingMilestoneTask["status"]; dueDate: string; snoozes?: unknown[] }[]>();
  const plan = planMilestones(
    existingRows.map((t) => ({ refKey: t.refKey, status: t.status, dueDate: t.dueDate, snoozeCount: t.snoozes?.length ?? 0 })),
    desired,
  );

  const taskFor = (d: (typeof desired)[number]) => ({
    candidateId,
    kind: "milestone" as const,
    category: "immigration" as const,
    refKey: d.refKey,
    title: `${d.title} (${AUTH_TYPE_LABELS[d.authType]})`,
    description: d.note,
    checklist: d.checklist,
    dueDate: d.dueDate,
    ownerId: candidate.ownerId ?? null,
    priority: d.priority,
    meta: { milestoneType: d.type, authorizationPeriodId: d.authorizationPeriodId, anchorDate: d.anchorDate, authType: d.authType },
    createdBy: actor?.id ?? null,
  });

  for (const d of plan.create) {
    const { created } = await upsertSystemTask(taskFor(d));
    if (created) result.created++;
  }
  for (const u of plan.update) {
    const d = desired.find((x) => x.refKey === u.refKey)!;
    await upsertSystemTask(taskFor(d)); // re-dates only open, never-snoozed tasks
    result.updated++;
  }
  for (const d of plan.reopen) {
    const r = await Task.updateOne(
      { candidateId, refKey: d.refKey, status: "cancelled", source: "system" },
      { $set: { status: "open", dueDate: d.dueDate, originalDueDate: d.dueDate, ownerId: candidate.ownerId ?? null }, $unset: { cancelledReason: "" } },
    );
    result.reopened += r.modifiedCount;
  }
  for (const key of plan.cancel) {
    result.cancelled += await cancelSystemTasks(candidateId, key, OBSOLETE_MILESTONE_REASON);
  }

  const enforced = await enforceClearance(candidateId, actor, today);
  result.clearanceRevoked = enforced.revoked;
  await refreshRiskFlags(candidateId, today);
  await refreshCandidateNextDue(candidateId);
  return result;
}
