import { z } from "zod";
import type { HydratedDocument } from "mongoose";
import { connectDb } from "@/lib/db/connect";
import { Task, TASK_CATEGORIES, type ITask, type TaskStatus } from "@/lib/db/models/task";
import { User, type IUser } from "@/lib/db/models/user";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { DocumentModel } from "@/lib/db/models/document";
import { audit } from "@/lib/audit";
import { loadCandidateFor } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { assertCan, can, canAccessCandidate, ForbiddenError } from "@/lib/rbac/can";
import { isDateOnly } from "@/lib/compliance/dates";
import { createNotifications } from "@/lib/notifications/service";
import { syncReviewFromTask } from "@/lib/tracker/sync";
import { refreshCandidateNextDue } from "./core";
import { visibleCategories } from "./filters";
import {
  editPermissionForKind,
  evaluateCompletion,
  evaluateStatusChange,
  evaluateWaiver,
  planSnooze,
  type CompletionInput,
} from "./lifecycle";

/** Business-rule failure (bad input / illegal transition) — server actions turn it into a form error, REST into 422. */
export class TaskError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "TaskError";
    this.status = status;
  }
}

const notFound = () => new TaskError("Task not found.", 404);

type TaskDoc = HydratedDocument<ITask>;

/**
 * Load a task ONLY if the actor may see it: category visible to their role AND record-level candidate access
 * (no access ⇒ same "not found" as a missing task so existence isn't leaked). Never relies on the UI hiding things.
 */
export async function loadTaskFor(actor: SessionUser, id: string): Promise<TaskDoc | null> {
  if (!can(actor, "tasks.view") && !can(actor, "tracker.view")) throw new ForbiddenError();
  await connectDb();
  const t = await Task.findById(id);
  if (!t) return null;
  // tracker-only viewers may only reach tracker (monthly review) tasks
  if (!can(actor, "tasks.view") && t.category !== "tracker") return null;
  if (!visibleCategories(actor).includes(t.category)) return null;
  if (t.candidateId) {
    const c = await loadCandidateFor(actor, t.candidateId);
    return c ? t : null;
  }
  return can(actor, "candidates.viewAll") || t.ownerId === actor.id || t.createdBy === actor.id ? t : null;
}

/** Load + require the edit permission for this kind of task (monthly reviews need tracker.edit, others tasks.edit). */
async function loadForEdit(actor: SessionUser, id: string): Promise<TaskDoc> {
  const t = await loadTaskFor(actor, id);
  if (!t) throw notFound();
  assertCan(actor, editPermissionForKind(t.kind));
  return t;
}

async function afterChange(t: ITask) {
  if (t.candidateId) await refreshCandidateNextDue(t.candidateId);
  await syncReviewFromTask(t);
}

const snapshot = (t: ITask) => ({
  status: t.status,
  dueDate: t.dueDate,
  originalDueDate: t.originalDueDate,
  ownerId: t.ownerId ?? null,
  outcome: t.outcome,
});

async function save(t: TaskDoc) {
  await t.save();
  const plain = t.toObject() as ITask;
  await afterChange(plain);
  return plain;
}

/* ------------------------------- complete ------------------------------- */

export const completeSchema = z.object({
  outcome: z.string().trim().max(2000).optional(),
  evidenceNote: z.string().trim().max(4000).optional(),
  documentId: z.string().trim().max(100).optional().nullable(),
  checklistWaiverReason: z.string().trim().max(2000).optional(),
});

export async function completeTask(actor: SessionUser, id: string, input: CompletionInput) {
  const t = await loadForEdit(actor, id);
  const check = evaluateCompletion(t, input);
  if (!check.ok) throw new TaskError(check.error);
  if (input.documentId) {
    await connectDb();
    const doc = await DocumentModel.exists({ _id: input.documentId, candidateId: t.candidateId });
    if (!doc) throw new TaskError("That document was not found on this candidate.");
  }
  const before = snapshot(t);
  const now = new Date();
  if (input.evidenceNote?.trim() || input.documentId) {
    t.evidence.push({ documentId: input.documentId ?? null, note: input.evidenceNote?.trim(), at: now, by: actor.id });
  }
  if (check.waivedChecklist) {
    const reason = input.checklistWaiverReason!.trim();
    t.notes.push({ text: `Unfinished checklist items waived: ${reason}`, at: now, by: actor.id, byName: actor.name });
    t.meta = { ...(t.meta ?? {}), checklistWaiver: { reason, at: now.toISOString(), by: actor.id } };
    t.markModified("meta");
  }
  t.status = "completed";
  t.outcome = input.outcome!.trim();
  t.completedAt = now;
  t.completedBy = actor.id;
  const saved = await save(t);
  await audit({
    actor, action: "status_change", entityType: "task", entityId: id, candidateId: t.candidateId,
    summary: `Completed task "${t.title}"${check.waivedChecklist ? " (checklist items waived)" : ""}`,
    reason: input.checklistWaiverReason, before, after: snapshot(saved),
  });
  return saved;
}

/* -------------------------------- waive -------------------------------- */

export async function waiveTask(actor: SessionUser, id: string, reason: string) {
  const t = await loadForEdit(actor, id);
  const check = evaluateWaiver(t, reason);
  if (!check.ok) throw new TaskError(check.error);
  const before = snapshot(t);
  const now = new Date();
  t.status = "waived";
  t.waivedReason = reason.trim();
  t.completedAt = now;
  t.completedBy = actor.id;
  const saved = await save(t);
  await audit({
    actor, action: "status_change", entityType: "task", entityId: id, candidateId: t.candidateId,
    summary: `Waived task "${t.title}"`, reason: reason.trim(), before, after: snapshot(saved),
  });
  return saved;
}

/* ------------------------------- snooze ------------------------------- */

/** Snooze = new LATER due date + reason. originalDueDate and the full snooze history are preserved. */
export async function snoozeTask(actor: SessionUser, id: string, input: { newDueDate: string; reason: string }) {
  const t = await loadForEdit(actor, id);
  const plan = planSnooze(t, { newDueDate: input.newDueDate, reason: input.reason, by: actor.id });
  if (!plan.ok) throw new TaskError(plan.error);
  const before = snapshot(t);
  t.dueDate = plan.patch.dueDate;
  t.originalDueDate = plan.patch.originalDueDate;
  t.snoozes = plan.patch.snoozes;
  t.escalationLevel = plan.patch.escalationLevel;
  const saved = await save(t);
  await audit({
    actor, action: "status_change", entityType: "task", entityId: id, candidateId: t.candidateId,
    summary: `Snoozed task "${t.title}" from ${before.dueDate} to ${plan.patch.dueDate}`,
    reason: input.reason.trim(), before, after: snapshot(saved),
  });
  return saved;
}

/* ------------------------------ status/notes ------------------------------ */

export async function setTaskStatus(actor: SessionUser, id: string, status: TaskStatus) {
  const t = await loadForEdit(actor, id);
  const check = evaluateStatusChange(t.status, status);
  if (!check.ok) throw new TaskError(check.error);
  if (t.status === status) return t.toObject() as ITask;
  const before = snapshot(t);
  t.status = status;
  const saved = await save(t);
  await audit({
    actor, action: "status_change", entityType: "task", entityId: id, candidateId: t.candidateId,
    summary: `Task "${t.title}" status ${before.status} → ${status}`, before, after: snapshot(saved),
  });
  return saved;
}

export async function addTaskNote(actor: SessionUser, id: string, text: string) {
  const clean = text.trim();
  if (!clean) throw new TaskError("Enter a note.");
  if (clean.length > 4000) throw new TaskError("Note is too long.");
  const t = await loadForEdit(actor, id);
  t.notes.push({ text: clean, at: new Date(), by: actor.id, byName: actor.name });
  const saved = await save(t);
  await audit({ actor, action: "update", entityType: "task", entityId: id, candidateId: t.candidateId, summary: `Added a note to task "${t.title}"` });
  return saved;
}

export async function toggleChecklistItem(actor: SessionUser, id: string, index: number, done: boolean) {
  const t = await loadForEdit(actor, id);
  if (!["open", "in_progress", "waiting_candidate", "waiting_employer", "waiting_dso"].includes(t.status)) {
    throw new TaskError("Finished tasks cannot be edited.");
  }
  const item = t.checklist[index];
  if (!item) throw new TaskError("Checklist item not found.");
  item.done = done;
  t.markModified("checklist");
  const saved = await save(t);
  await audit({
    actor, action: "update", entityType: "task", entityId: id, candidateId: t.candidateId,
    summary: `Checklist "${item.label}" ${done ? "ticked" : "unticked"} on "${t.title}"`,
  });
  return saved;
}

/* ------------------------------- reassign ------------------------------- */

export async function reassignTask(actor: SessionUser, id: string, newOwnerId: string | null) {
  const t = await loadForEdit(actor, id);
  const before = snapshot(t);
  let ownerName = "Unassigned";
  if (newOwnerId) {
    await connectDb();
    const u = await User.findById(newOwnerId).lean<IUser>();
    if (!u || !u.active || !["super_admin", "compliance_manager", "compliance_associate"].includes(u.role)) {
      throw new TaskError("Choose an active compliance user.");
    }
    if (t.candidateId) {
      const c = await Candidate.findById(t.candidateId).select("ownerId teamMemberIds").lean<ICandidate>();
      const as = { id: u._id, role: u.role, extraPermissions: u.extraPermissions, deniedPermissions: u.deniedPermissions };
      if (!c || !canAccessCandidate(as, { ownerId: c.ownerId, teamMemberIds: c.teamMemberIds })) {
        throw new TaskError("That user cannot access this candidate. Assign them to the candidate first.");
      }
    }
    ownerName = u.name;
  }
  t.ownerId = newOwnerId;
  const saved = await save(t);
  await audit({
    actor, action: "update", entityType: "task", entityId: id, candidateId: t.candidateId,
    summary: `Reassigned task "${t.title}" to ${ownerName}`, before, after: snapshot(saved),
  });
  if (newOwnerId && newOwnerId !== actor.id) {
    await createNotifications([newOwnerId], {
      title: `Task assigned: ${t.title}`,
      body: `${actor.name} assigned you "${t.title}" (due ${t.dueDate}).`,
      link: t.candidateId ? `/candidates/${t.candidateId}?tab=${t.kind === "monthly_review" ? "tracker" : "tasks"}` : "/calendar",
      kind: "assignment",
    });
  }
  return saved;
}

/* ------------------------------ manual tasks ------------------------------ */

export const manualTaskSchema = z.object({
  candidateId: z.string().trim().optional().nullable(),
  title: z.string().trim().min(3, "Enter a title").max(200),
  description: z.string().trim().max(4000).optional(),
  dueDate: z.string().refine(isDateOnly, "Enter a valid due date"),
  ownerId: z.string().trim().optional().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  category: z.enum(TASK_CATEGORIES).default("general"),
});
export type ManualTaskInput = z.input<typeof manualTaskSchema>;

/** Staff with tasks.edit can create manual tasks. A task on a candidate requires access to that candidate. */
export async function createManualTask(actor: SessionUser, raw: ManualTaskInput) {
  assertCan(actor, "tasks.edit");
  const input = manualTaskSchema.parse(raw);
  await connectDb();
  if (input.candidateId) {
    const c = await loadCandidateFor(actor, input.candidateId);
    if (!c) throw new TaskError("Candidate not found.", 404);
  }
  if (!visibleCategories(actor).includes(input.category)) throw new ForbiddenError();
  if (input.ownerId) {
    const u = await User.findById(input.ownerId).select("active role").lean<IUser>();
    if (!u || !u.active) throw new TaskError("Choose an active user as owner.");
  }
  const t = await Task.create({
    candidateId: input.candidateId || null,
    kind: "manual",
    category: input.category,
    title: input.title,
    description: input.description,
    dueDate: input.dueDate,
    originalDueDate: input.dueDate,
    ownerId: input.ownerId || actor.id,
    priority: input.priority,
    source: "manual",
    createdBy: actor.id,
  });
  const plain = t.toObject() as ITask;
  await afterChange(plain);
  await audit({
    actor, action: "create", entityType: "task", entityId: plain._id, candidateId: plain.candidateId,
    summary: `Created task "${plain.title}" due ${plain.dueDate}`, after: snapshot(plain),
  });
  return plain;
}
