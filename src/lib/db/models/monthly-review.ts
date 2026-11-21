import { makeSchema, model } from "../base";
import { TASK_STATUSES, type TaskStatus } from "./task";

/**
 * 12-month operational tracker (AC-07). This is an INTERNAL review aid — it never replaces official DSO/SEVIS reporting.
 * `tracker_cycles` holds the cycle (anchor + the recorded reason for the anchor); `monthly_reviews` holds one row per month
 * and links to the Task (refKey `monthly:<cycleId>:<month>`) which is the source of truth for status/checklist/evidence.
 */
export interface ITrackerCycle {
  _id: string; // cycleId
  candidateId: string;
  cycleNumber: number; // 1, 2, ... per candidate
  anchorDate: string; // date-only; month N is due N months after
  anchorReason: string; // required: why this anchor was chosen
  anchorChosenBy?: string | null; // null = system default
  status: "open" | "closed";
  closedAt?: Date | null;
  closedBy?: string | null;
  closeNote?: string;
  startedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const cycleSchema = makeSchema<ITrackerCycle>({
  candidateId: { type: String, required: true, index: true },
  cycleNumber: { type: Number, required: true },
  anchorDate: { type: String, required: true },
  anchorReason: { type: String, required: true },
  anchorChosenBy: { type: String, default: null },
  status: { type: String, enum: ["open", "closed"], default: "open" },
  closedAt: { type: Date, default: null },
  closedBy: { type: String, default: null },
  closeNote: String,
  startedBy: { type: String, default: null },
});
cycleSchema.index({ candidateId: 1, cycleNumber: 1 }, { unique: true });
// at most ONE open cycle per candidate (also guards concurrent "Start cycle" clicks / onboarding race)
// Explicitly NAMED so it can never collide with the plain {candidateId:1} index (an unnamed unique-partial index on the
// same key auto-generates the same name and is silently skipped — that was the bug in the emergency-payroll model).
cycleSchema.index({ candidateId: 1 }, { unique: true, partialFilterExpression: { status: "open" }, name: "one_open_cycle_per_candidate" });

export const TrackerCycle = model<ITrackerCycle>("TrackerCycle", cycleSchema, "tracker_cycles");

export interface IMonthlyReview {
  _id: string;
  candidateId: string;
  cycleId: string;
  cycleStart: string; // anchor, denormalised
  anchorReason: string;
  monthNumber: number; // 1..12
  dueDate: string;
  status: TaskStatus; // mirrored from the task
  checklist: { label: string; done: boolean }[]; // mirrored from the task
  reviewerId?: string | null; // who completed / waived it
  taskId: string;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = makeSchema<IMonthlyReview>({
  candidateId: { type: String, required: true, index: true },
  cycleId: { type: String, required: true },
  cycleStart: { type: String, required: true },
  anchorReason: { type: String, required: true },
  monthNumber: { type: Number, required: true, min: 1, max: 12 },
  dueDate: { type: String, required: true },
  status: { type: String, enum: TASK_STATUSES, default: "open" },
  checklist: { type: [{ _id: false, label: String, done: Boolean }], default: [] },
  reviewerId: { type: String, default: null },
  taskId: { type: String, required: true, index: true },
});
reviewSchema.index({ cycleId: 1, monthNumber: 1 }, { unique: true });

export const MonthlyReview = model<IMonthlyReview>("MonthlyReview", reviewSchema, "monthly_reviews");
