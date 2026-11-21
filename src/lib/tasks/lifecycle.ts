import { validateSnooze } from "@/lib/reminders/engine";
import { isDateOnly } from "@/lib/compliance/dates";
import { OPEN_TASK_STATUSES, type TaskKind, type TaskStatus } from "@/lib/tasks/constants";
import type { ITask } from "@/lib/db/models/task";
import type { Permission } from "@/lib/rbac/permissions";

/**
 * Pure task-lifecycle rules (no DB / no session) so they are unit-tested in isolation.
 * Completion, waiver and snooze each leave a full history; nothing is deleted or silently overwritten.
 */

type TaskLike = Pick<ITask, "kind" | "status" | "dueDate" | "originalDueDate" | "checklist" | "snoozes" | "escalationLevel">;

/** Monthly (tracker) tasks are edited with `tracker.edit`; everything else with `tasks.edit`. */
export function editPermissionForKind(kind: TaskKind): Permission {
  return kind === "monthly_review" ? "tracker.edit" : "tasks.edit";
}

export const isOpenStatus = (s: TaskStatus) => OPEN_TASK_STATUSES.includes(s);

/** Statuses a user may move an OPEN task between. Completed/waived/cancelled are reached only via their own flows. */
export const MANUAL_STATUSES: TaskStatus[] = ["open", "in_progress", "waiting_candidate", "waiting_employer", "waiting_dso"];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_candidate: "Waiting on candidate",
  waiting_employer: "Waiting on employer",
  waiting_dso: "Waiting on DSO",
  completed: "Completed",
  waived: "Waived",
  cancelled: "Cancelled",
};

export function checklistComplete(checklist: { done: boolean }[]): boolean {
  return checklist.every((i) => i.done);
}

/** Kinds whose completion must carry evidence (a note or a document). Manual to-dos only need an outcome. */
export const EVIDENCE_REQUIRED = (kind: TaskKind) => kind !== "manual";

export interface CompletionInput {
  outcome?: string;
  evidenceNote?: string;
  documentId?: string | null;
  /** Required when checklist items are still unticked: completion is allowed only with a recorded waiver reason. */
  checklistWaiverReason?: string;
}

export type CompletionCheck =
  | { ok: true; waivedChecklist: boolean }
  | { ok: false; error: string };

export function evaluateCompletion(task: Pick<ITask, "kind" | "status" | "checklist">, input: CompletionInput): CompletionCheck {
  if (!isOpenStatus(task.status)) return { ok: false, error: "Only open tasks can be completed." };
  if (!input.outcome || input.outcome.trim().length < 3) return { ok: false, error: "Record the outcome." };
  const hasEvidence = !!(input.evidenceNote?.trim() || input.documentId);
  if (EVIDENCE_REQUIRED(task.kind) && !hasEvidence) return { ok: false, error: "Attach evidence: a note or a document." };
  if (!checklistComplete(task.checklist)) {
    if (!input.checklistWaiverReason || input.checklistWaiverReason.trim().length < 5) {
      return { ok: false, error: "Complete every checklist item, or give a waiver reason for the unfinished items." };
    }
    return { ok: true, waivedChecklist: true };
  }
  return { ok: true, waivedChecklist: false };
}

export function evaluateWaiver(task: Pick<ITask, "status">, reason?: string): { ok: true } | { ok: false; error: string } {
  if (!isOpenStatus(task.status)) return { ok: false, error: "Only open tasks can be waived." };
  if (!reason || reason.trim().length < 5) return { ok: false, error: "A reason (at least 5 characters) is required to waive a task." };
  return { ok: true };
}

export function evaluateStatusChange(from: TaskStatus, to: TaskStatus): { ok: true } | { ok: false; error: string } {
  if (!isOpenStatus(from)) return { ok: false, error: "Finished tasks cannot change status." };
  if (!MANUAL_STATUSES.includes(to)) return { ok: false, error: "Use Complete or Waive to finish a task." };
  return { ok: true };
}

export interface SnoozePatch {
  dueDate: string;
  /** Unchanged: the first due date is preserved forever. */
  originalDueDate: string;
  snoozes: ITask["snoozes"];
  /** Overdue ladder restarts for the new date (reminder keys include the due date, so earlier sends never repeat). */
  escalationLevel: 0;
}

/**
 * Snooze = push the due date later. Requires a reason and a strictly later date (`validateSnooze`).
 * originalDueDate is never modified and every snooze is appended to the history.
 */
export function planSnooze(
  task: TaskLike,
  req: { newDueDate: string; reason: string; by: string; at?: Date },
): { ok: true; patch: SnoozePatch } | { ok: false; error: string } {
  if (!isOpenStatus(task.status)) return { ok: false, error: "Only open tasks can be snoozed." };
  if (!isDateOnly(req.newDueDate)) return { ok: false, error: "Enter a valid new due date." };
  const v = validateSnooze({ reason: req.reason, currentDueDate: task.dueDate, newDueDate: req.newDueDate });
  if (!v.ok) return v;
  return {
    ok: true,
    patch: {
      dueDate: req.newDueDate,
      originalDueDate: task.originalDueDate || task.dueDate,
      snoozes: [
        ...task.snoozes,
        { from: task.dueDate, to: req.newDueDate, reason: req.reason.trim(), at: req.at ?? new Date(), by: req.by },
      ],
      escalationLevel: 0,
    },
  };
}
