import { makeSchema, model } from "../base";

// Enums live in a DB-free module (see lib/tasks/constants.ts); re-exported here for existing imports.
import { TASK_KINDS, TASK_STATUSES, OPEN_TASK_STATUSES, TASK_CATEGORIES, type TaskKind, type TaskStatus, type TaskCategory } from "@/lib/tasks/constants";
export { TASK_KINDS, TASK_STATUSES, OPEN_TASK_STATUSES, TASK_CATEGORIES };
export type { TaskKind, TaskStatus, TaskCategory };

export interface ITask {
  _id: string;
  candidateId: string | null;
  kind: TaskKind;
  category: TaskCategory;
  /** Idempotency key within a candidate, e.g. "milestone:stem_validation_6m:2026-01-15" or "monthly:<cycleId>:3". */
  refKey?: string | null;
  title: string;
  description?: string;
  checklist: { label: string; done: boolean }[];
  ownerId?: string | null;
  dueDate: string; // CURRENT due date (date-only)
  originalDueDate: string; // never changes, even after snoozes
  status: TaskStatus;
  priority: "low" | "normal" | "high" | "urgent";
  evidence: { documentId?: string | null; note?: string; at: Date; by: string }[];
  notes: { text: string; at: Date; by: string; byName?: string }[];
  snoozes: { from: string; to: string; reason: string; at: Date; by: string }[];
  completedAt?: Date | null;
  completedBy?: string | null;
  outcome?: string;
  waivedReason?: string;
  cancelledReason?: string;
  source: "system" | "manual";
  /** Highest overdue-escalation level already notified (0 owner,1 team lead,2 compliance mgr,3 admin). */
  escalationLevel: number;
  lastEscalatedAt?: Date | null;
  meta?: Record<string, unknown>; // milestoneType, monthNumber, cycleId, ...
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = makeSchema<ITask>({
  candidateId: { type: String, default: null, index: true },
  kind: { type: String, enum: TASK_KINDS, required: true },
  category: { type: String, enum: TASK_CATEGORIES, default: "general" },
  refKey: { type: String, default: null },
  title: { type: String, required: true },
  description: String,
  checklist: { type: [{ _id: false, label: String, done: { type: Boolean, default: false } }], default: [] },
  ownerId: { type: String, default: null, index: true },
  dueDate: { type: String, required: true, index: true },
  originalDueDate: { type: String, required: true },
  status: { type: String, enum: TASK_STATUSES, default: "open", index: true },
  priority: { type: String, enum: ["low", "normal", "high", "urgent"], default: "normal" },
  evidence: { type: [{ _id: false, documentId: String, note: String, at: Date, by: String }], default: [] },
  notes: { type: [{ _id: false, text: String, at: Date, by: String, byName: String }], default: [] },
  snoozes: { type: [{ _id: false, from: String, to: String, reason: String, at: Date, by: String }], default: [] },
  completedAt: { type: Date, default: null },
  completedBy: { type: String, default: null },
  outcome: String,
  waivedReason: String,
  cancelledReason: String,
  source: { type: String, enum: ["system", "manual"], default: "system" },
  escalationLevel: { type: Number, default: 0 },
  lastEscalatedAt: { type: Date, default: null },
  meta: { type: Object },
  createdBy: { type: String, default: null },
});
// System tasks are idempotent per (candidate, refKey): regenerating a schedule can never duplicate them.
schema.index({ candidateId: 1, refKey: 1 }, { unique: true, partialFilterExpression: { refKey: { $type: "string" } } });
schema.index({ status: 1, dueDate: 1 });

export const Task = model<ITask>("Task", schema, "tasks");
