/**
 * Hook points the candidate service calls when something happens that should raise internal tasks (AC-06).
 * Keep the signatures stable — other modules depend on them.
 */
import type { SessionUser } from "@/lib/auth/session";
import { connectDb } from "@/lib/db/connect";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { audit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";
import { refreshCandidateNextDue, upsertSystemTask } from "@/lib/tasks/core";
import { addBusinessDays, todayFor } from "@/lib/immigration/calendar";
import { changeReviewRefKey } from "@/lib/immigration/change-review";
import { regenerateSchedule } from "@/lib/immigration/schedule";
import { ensureTrackerCycleFor } from "@/lib/tracker/service";

export type MaterialChangeField = "employer" | "address" | "hours" | "compensation" | "trainingPlan" | "jobDuties" | "worksite";

const FIELD_PHRASE: Record<MaterialChangeField, string> = {
  employer: "employer changed",
  address: "address changed",
  hours: "work hours changed",
  compensation: "compensation changed",
  trainingPlan: "training plan changed",
  jobDuties: "job duties changed",
  worksite: "worksite changed",
};

/** Business days the owner has to assess a change. */
export const CHANGE_REVIEW_BUSINESS_DAYS = 3;


/** A change in employer, address, hours, compensation or training plan must create a review task. No legal conclusion is made. */
export async function raiseChangeReview(args: {
  actor: SessionUser | null;
  candidateId: string;
  fields: MaterialChangeField[];
  summary: string;
}): Promise<void> {
  if (!args.fields.length) return;
  await connectDb();
  const candidate = await Candidate.findById(args.candidateId).select("ownerId").lean<ICandidate>();
  if (!candidate) return;
  const today = todayFor(args.actor);
  const holidays = new Set(await getSetting("reminders.holidays"));
  const fields = [...new Set(args.fields)];
  const refKey = changeReviewRefKey(fields, today, args.summary);

  const { created } = await upsertSystemTask({
    candidateId: args.candidateId,
    kind: "change_review",
    category: "immigration",
    refKey,
    title: `Review: ${fields.map((f) => FIELD_PHRASE[f]).join(", ")} — assess DSO/I-983 reporting`,
    description: `${args.summary}\n\nThis is an internal review prompt only. No automatic legal conclusion is made; confirm any reporting requirement with the DSO / immigration counsel.`,
    checklist: [
      "Confirm what changed and the effective date",
      "Check whether a DSO / SEVIS update is required (confirm with DSO)",
      "Check whether the Form I-983 needs an update (STEM OPT)",
      "Record the outcome and attach evidence",
    ],
    dueDate: addBusinessDays(today, CHANGE_REVIEW_BUSINESS_DAYS, holidays),
    ownerId: candidate.ownerId ?? null,
    priority: "high",
    meta: { fields, summary: args.summary },
    createdBy: args.actor?.id ?? null,
  });
  if (created) {
    await audit({
      actor: args.actor,
      action: "create",
      entityType: "change_review_task",
      candidateId: args.candidateId,
      summary: `Change-review task raised (${fields.join(", ")}): ${args.summary}`,
    });
  }
  await refreshCandidateNextDue(args.candidateId);
}

/**
 * Re-derive milestones from VERIFIED authorization periods, cancel obsolete ones (history kept), re-check clearance,
 * refresh immigration risk flags and the candidate's next-due date. Idempotent.
 */
export async function regenerateComplianceSchedule(args: { actor: SessionUser | null; candidateId: string }): Promise<void> {
  await regenerateSchedule(args);
  // Onboarding / active candidates get their 12-month review cycle (idempotent; never throws).
  await ensureTrackerCycleFor(args.candidateId);
}
