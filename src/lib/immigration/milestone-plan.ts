import { addDays, compareDates, type DateOnly } from "@/lib/compliance/dates";
import { generateExpiryMilestones, generateStemMilestones, type MilestoneDraft, type MilestoneType } from "@/lib/compliance/milestones";
import { OPEN_TASK_STATUSES, type TaskStatus } from "@/lib/tasks/constants";

/**
 * Pure planning for compliance milestones. Milestones are generated ONLY from verified authorization periods
 * (verified evidence + reviewer). The engines in lib/compliance/milestones.ts own the date math; this file only
 * turns their drafts into idempotent task keys and diffs them against what already exists.
 */

export const MILESTONE_REF_PREFIX = "milestone:";
/** Overdue milestones of an authorization that already ended are not created if due more than this many days ago. */
export const STALE_MILESTONE_DAYS = 30;

export interface VerifiedPeriodInput {
  id: string;
  type: "CPT" | "OPT" | "STEM_OPT";
  startDate: DateOnly;
  endDate: DateOnly;
}

export interface DesiredMilestone extends MilestoneDraft {
  refKey: string;
  authorizationPeriodId: string;
  authType: VerifiedPeriodInput["type"];
  priority: "normal" | "high";
  /** True when the milestone is long past on an ended authorization: kept if already present, never newly created. */
  skipCreate: boolean;
}

export const milestoneRefKey = (type: MilestoneType, anchorDate: DateOnly) => `${MILESTONE_REF_PREFIX}${type}:${anchorDate}`;

const HIGH: MilestoneType[] = ["authorization_expiry_30d", "stem_final_evaluation_24m", "stem_evaluation_12m"];

/** Desired milestone set for a candidate's VERIFIED periods. Duplicate (type, anchor) pairs collapse to the first. */
export function buildDesiredMilestones(periods: VerifiedPeriodInput[], today: DateOnly): DesiredMilestone[] {
  const out = new Map<string, DesiredMilestone>();
  for (const p of periods) {
    const drafts = [
      ...(p.type === "STEM_OPT" ? generateStemMilestones(p.startDate, p.endDate) : []),
      ...generateExpiryMilestones(p.endDate),
    ];
    const ended = compareDates(p.endDate, today) < 0;
    for (const d of drafts) {
      const refKey = milestoneRefKey(d.type, d.anchorDate);
      if (out.has(refKey)) continue;
      out.set(refKey, {
        ...d,
        refKey,
        authorizationPeriodId: p.id,
        authType: p.type,
        priority: HIGH.includes(d.type) ? "high" : "normal",
        skipCreate: ended && compareDates(d.dueDate, addDays(today, -STALE_MILESTONE_DAYS)) < 0,
      });
    }
  }
  return [...out.values()].sort((a, b) => compareDates(a.dueDate, b.dueDate));
}

export interface ExistingMilestoneTask {
  refKey: string;
  status: TaskStatus;
  dueDate: DateOnly;
  snoozeCount?: number;
}

export interface MilestonePlan<T extends { refKey: string; dueDate: DateOnly }> {
  /** Not present yet → create. */
  create: T[];
  /** Open, never-snoozed task whose verified date moved → re-date. */
  update: { refKey: string; from: DateOnly; to: DateOnly }[];
  /** Previously cancelled (e.g. un-verified) and desired again → reopen. */
  reopen: T[];
  /** Open task no longer backed by a verified date → cancel (never delete). */
  cancel: string[];
  /** Everything else, including completed/waived history, which is always preserved. */
  keep: string[];
}

/** Diff existing milestone tasks against the desired set. Completed / waived tasks are history and are never touched. */
export function planMilestones<T extends { refKey: string; dueDate: DateOnly; skipCreate?: boolean }>(
  existingTasks: ExistingMilestoneTask[],
  desired: T[],
): MilestonePlan<T> {
  const plan: MilestonePlan<T> = { create: [], update: [], reopen: [], cancel: [], keep: [] };
  const existing = new Map(existingTasks.map((t) => [t.refKey, t]));
  const want = new Map(desired.map((d) => [d.refKey, d]));

  for (const d of desired) {
    const e = existing.get(d.refKey);
    if (!e) {
      if (!d.skipCreate) plan.create.push(d);
      continue;
    }
    if (e.status === "cancelled") {
      if (d.skipCreate) plan.keep.push(d.refKey);
      else plan.reopen.push(d);
    } else if (e.status === "open" && !(e.snoozeCount && e.snoozeCount > 0) && e.dueDate !== d.dueDate) {
      plan.update.push({ refKey: d.refKey, from: e.dueDate, to: d.dueDate });
    } else {
      plan.keep.push(d.refKey);
    }
  }
  for (const e of existingTasks) {
    if (want.has(e.refKey)) continue;
    if ((OPEN_TASK_STATUSES as TaskStatus[]).includes(e.status)) plan.cancel.push(e.refKey);
    else plan.keep.push(e.refKey); // completed / waived / already cancelled history
  }
  return plan;
}
