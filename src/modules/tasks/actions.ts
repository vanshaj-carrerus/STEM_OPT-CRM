"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { requireAction } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/rbac/can";
import {
  TaskError,
  addTaskNote,
  completeTask,
  createManualTask,
  reassignTask,
  setTaskStatus,
  snoozeTask,
  toggleChecklistItem,
  waiveTask,
} from "@/lib/tasks/service";
import { MANUAL_STATUSES } from "@/lib/tasks/lifecycle";
import type { ITask, TaskStatus } from "@/lib/db/models/task";

export interface TaskFormState {
  error?: string;
  saved?: boolean;
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

/** Every action re-checks the session + permission server-side; the service re-checks record access + edit rights. */
async function guarded(fn: (actor: SessionUser) => Promise<Pick<ITask, "candidateId">>): Promise<TaskFormState> {
  try {
    const actor = await requireAction("tasks.view", "tracker.view");
    const t = await fn(actor);
    if (t.candidateId) revalidatePath(`/candidates/${t.candidateId}`);
    revalidatePath("/calendar");
    revalidatePath("/dashboard");
    return { saved: true };
  } catch (e) {
    if (e instanceof TaskError || e instanceof ForbiddenError) return { error: e.message };
    if (e instanceof ZodError) return { error: e.issues[0]?.message ?? "Please check the form." };
    throw e;
  }
}

export async function completeTaskAction(_p: TaskFormState, fd: FormData): Promise<TaskFormState> {
  return guarded((actor) =>
    completeTask(actor, str(fd, "id"), {
      outcome: str(fd, "outcome"),
      evidenceNote: str(fd, "evidenceNote") || undefined,
      documentId: str(fd, "documentId") || undefined,
      checklistWaiverReason: str(fd, "checklistWaiverReason") || undefined,
    }),
  );
}

export async function waiveTaskAction(_p: TaskFormState, fd: FormData): Promise<TaskFormState> {
  return guarded((actor) => waiveTask(actor, str(fd, "id"), str(fd, "reason")));
}

export async function snoozeTaskAction(_p: TaskFormState, fd: FormData): Promise<TaskFormState> {
  return guarded((actor) => snoozeTask(actor, str(fd, "id"), { newDueDate: str(fd, "newDueDate"), reason: str(fd, "reason") }));
}

export async function reassignTaskAction(_p: TaskFormState, fd: FormData): Promise<TaskFormState> {
  return guarded((actor) => reassignTask(actor, str(fd, "id"), str(fd, "ownerId") || null));
}

export async function noteTaskAction(_p: TaskFormState, fd: FormData): Promise<TaskFormState> {
  return guarded((actor) => addTaskNote(actor, str(fd, "id"), str(fd, "text")));
}

const statusSchema = z.enum(MANUAL_STATUSES as [TaskStatus, ...TaskStatus[]]);

export async function statusTaskAction(_p: TaskFormState, fd: FormData): Promise<TaskFormState> {
  return guarded((actor) => setTaskStatus(actor, str(fd, "id"), statusSchema.parse(str(fd, "status"))));
}

export async function createTaskAction(_p: TaskFormState, fd: FormData): Promise<TaskFormState> {
  return guarded((actor) =>
    createManualTask(actor, {
      candidateId: str(fd, "candidateId") || null,
      title: str(fd, "title"),
      description: str(fd, "description") || undefined,
      dueDate: str(fd, "dueDate"),
      ownerId: str(fd, "ownerId") || null,
      priority: (str(fd, "priority") || "normal") as "normal",
      category: (str(fd, "category") || "general") as "general",
    }),
  );
}

/** Tick / untick one checklist item (used by the tracker and tasks tabs). */
export async function toggleChecklistAction(taskId: string, index: number, done: boolean): Promise<TaskFormState> {
  return guarded((actor) => toggleChecklistItem(actor, taskId, index, done));
}
