import { connectDb } from "@/lib/db/connect";
import { Task, OPEN_TASK_STATUSES, type ITask, type TaskCategory, type TaskKind } from "@/lib/db/models/task";
import { Candidate } from "@/lib/db/models/candidate";

/**
 * Idempotent task creation used by every module that raises work (milestones, monthly reviews, change reviews,
 * payroll/payment exceptions). Safe to call repeatedly — (candidateId, refKey) is unique.
 */
export interface UpsertTaskInput {
  candidateId: string | null;
  kind: TaskKind;
  category: TaskCategory;
  refKey: string;
  title: string;
  description?: string;
  checklist?: string[];
  dueDate: string;
  ownerId?: string | null;
  priority?: ITask["priority"];
  meta?: Record<string, unknown>;
  createdBy?: string | null;
}

export async function upsertSystemTask(input: UpsertTaskInput): Promise<{ created: boolean; task: ITask }> {
  await connectDb();
  const existing = await Task.findOne({ candidateId: input.candidateId, refKey: input.refKey });
  if (existing) {
    // Only re-date OPEN, never-snoozed tasks when the underlying verified date changed; never touch finished work.
    if (existing.status === "open" && existing.snoozes.length === 0 && existing.dueDate !== input.dueDate) {
      existing.dueDate = input.dueDate;
      existing.originalDueDate = input.dueDate;
      await existing.save();
    }
    return { created: false, task: existing.toObject() as ITask };
  }
  try {
    const t = await Task.create({
      candidateId: input.candidateId,
      kind: input.kind,
      category: input.category,
      refKey: input.refKey,
      title: input.title,
      description: input.description,
      checklist: (input.checklist ?? []).map((label) => ({ label, done: false })),
      dueDate: input.dueDate,
      originalDueDate: input.dueDate,
      ownerId: input.ownerId ?? null,
      priority: input.priority ?? "normal",
      meta: input.meta,
      source: "system",
      createdBy: input.createdBy ?? null,
    });
    return { created: true, task: t.toObject() as ITask };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const again = await Task.findOne({ candidateId: input.candidateId, refKey: input.refKey }).lean<ITask>();
      return { created: false, task: again! };
    }
    throw err;
  }
}

/** Cancel (never delete) OPEN system tasks whose refKey starts with a prefix — e.g. obsolete milestones after a date correction. */
export async function cancelSystemTasks(candidateId: string, refKeyPrefix: string, reason: string, keepRefKeys: string[] = []) {
  await connectDb();
  const escaped = refKeyPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const res = await Task.updateMany(
    { candidateId, refKey: { $regex: `^${escaped}`, $nin: keepRefKeys }, status: { $in: OPEN_TASK_STATUSES }, source: "system" },
    { $set: { status: "cancelled", cancelledReason: reason } },
  );
  return res.modifiedCount;
}

/** Recompute the denormalised `nextDueDate` shown in the candidate list from the earliest open task. */
export async function refreshCandidateNextDue(candidateId: string) {
  await connectDb();
  const next = await Task.findOne({ candidateId, status: { $in: OPEN_TASK_STATUSES } }).sort({ dueDate: 1 }).select("dueDate").lean<ITask>();
  await Candidate.updateOne({ _id: candidateId }, { $set: { nextDueDate: next?.dueDate ?? null } });
}
