import { compareDates, type DateOnly } from "@/lib/compliance/dates";
import {
  DEFAULT_OFFSETS,
  decideReminder,
  escalationLevel,
  escalationRecipients,
  reminderKey,
  type Audience,
  type Channel,
  type EscalationLevel,
} from "@/lib/reminders/engine";
import { renderCandidateReminder, renderEscalation, renderStaffReminder } from "@/lib/reminders/templates";
import { OPEN_TASK_STATUSES } from "@/lib/tasks/constants";
import type { ITask } from "@/lib/db/models/task";

/**
 * PURE planning for the daily job: given tasks + what was already sent + users + holidays + "today" (per task, in the
 * record's timezone) → a list of actions. No DB, no clock, no I/O — so routing/dedupe rules are unit-tested directly.
 * The runner executes the plan with insert-then-send against the unique reminder key.
 */

export type PlanTask = Pick<ITask, "kind" | "title" | "dueDate" | "status" | "ownerId" | "escalationLevel" | "meta"> & {
  id: string;
  candidateId: string | null;
  refKey?: string | null;
  /** Today's calendar date in THIS task's record timezone. */
  today: DateOnly;
};

export interface PlanCandidate {
  id: string;
  name: string;
  email?: string | null;
  ownerId?: string | null;
}

export interface PlanUser {
  id: string;
  role: string;
  active: boolean;
  teamLeadId?: string | null;
}

export interface PlanInput {
  tasks: PlanTask[];
  candidates: ReadonlyMap<string, PlanCandidate>;
  users: ReadonlyMap<string, PlanUser>;
  /** Reminder keys that already exist (any status) — the dedupe truth, mirrors the unique index. */
  existingKeys: ReadonlySet<string>;
  offsets?: readonly number[];
  offsetsByTaskType?: Record<string, readonly number[]>;
  holidays?: ReadonlySet<DateOnly>;
  staffEmailEnabled?: boolean;
  candidateEmailEnabled?: boolean;
}

export interface PlannedReminder {
  /** `skip` = a stale earlier offset: recorded, never sent. */
  mode: "send" | "skip";
  kind: "reminder" | "escalation";
  key: string;
  taskId: string;
  candidateId: string | null;
  taskType: string;
  dueDate: DateOnly;
  channel: Channel;
  audience: Audience;
  offset: string;
  templateKey: string;
  /** Staff user ids to notify (staff audience). */
  recipientIds: string[];
  /** Candidate email (candidate audience). */
  toEmail?: string;
  payload: { subject: string; title: string; body: string; link: string };
  /** Escalation level this action belongs to (escalations only). */
  level?: EscalationLevel;
}

/** Stable "task type" used in the dedupe key: system tasks use their refKey, manual tasks their id. */
export const taskTypeOf = (t: { kind: string; refKey?: string | null; id: string }) => t.refKey ?? `${t.kind}:${t.id}`;

export function sanitizeOffsets(o: readonly number[] | undefined): number[] {
  const list = (o ?? DEFAULT_OFFSETS).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365);
  return [...new Set(list)].sort((a, b) => b - a);
}

/** Per-task-type override: milestoneType, then kind, then the global offsets. */
export function offsetsFor(t: Pick<PlanTask, "kind" | "meta">, global: readonly number[] | undefined, byType: Record<string, readonly number[]> = {}): number[] {
  const milestoneType = typeof t.meta?.milestoneType === "string" ? t.meta.milestoneType : undefined;
  const chosen = (milestoneType && byType[milestoneType]) || byType[t.kind] || global;
  return sanitizeOffsets(chosen);
}

/** Tasks that are the candidate's to act on get a separate candidate-facing reminder (when that channel is enabled). */
export function isCandidateFacing(t: Pick<PlanTask, "kind" | "status" | "meta">): boolean {
  return t.kind === "document_request" || t.status === "waiting_candidate" || t.meta?.notifyCandidate === true;
}

export const taskLink = (t: { kind: string; candidateId: string | null }) =>
  t.candidateId ? `/candidates/${t.candidateId}?tab=${t.kind === "monthly_review" ? "tracker" : "tasks"}` : "/calendar";

export interface Resolved {
  ownerId: string | null;
  escalation: { ownerId: string | null; teamLeadId: string | null; complianceManagerIds: string[]; adminIds: string[] };
}

/** Who owns a task for notification purposes: the task owner, else the candidate owner (active users only). */
export function resolveOwnership(
  t: Pick<PlanTask, "ownerId" | "candidateId">,
  candidates: ReadonlyMap<string, PlanCandidate>,
  users: ReadonlyMap<string, PlanUser>,
): Resolved {
  const active = (id?: string | null) => (id && users.get(id)?.active ? id : null);
  const cand = t.candidateId ? candidates.get(t.candidateId) : undefined;
  const ownerId = active(t.ownerId) ?? active(cand?.ownerId);
  const owner = ownerId ? users.get(ownerId) : undefined;
  const all = [...users.values()].filter((u) => u.active);
  return {
    ownerId,
    escalation: {
      ownerId,
      teamLeadId: active(owner?.teamLeadId),
      complianceManagerIds: all.filter((u) => u.role === "compliance_manager").map((u) => u.id),
      adminIds: all.filter((u) => u.role === "super_admin").map((u) => u.id),
    },
  };
}

export function planReminders(input: PlanInput): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  const holidays = input.holidays ?? new Set<DateOnly>();
  const staffChannels: Channel[] = input.staffEmailEnabled === false ? ["in_app"] : ["in_app", "email"];

  for (const task of input.tasks) {
    if (!OPEN_TASK_STATUSES.includes(task.status)) continue;
    const cand = task.candidateId ? input.candidates.get(task.candidateId) : undefined;
    const taskType = taskTypeOf(task);
    const candidateKeyId = task.candidateId ?? "none";
    const link = taskLink(task);
    const keyOf = (channel: Channel, offset: number | "overdue" | `overdue-L${number}`, audience: Audience) =>
      reminderKey({ candidateId: candidateKeyId, taskType, dueDate: task.dueDate, channel, offset, audience });
    const base = { taskId: task.id, candidateId: task.candidateId, taskType, dueDate: task.dueDate };
    const owner = resolveOwnership(task, input.candidates, input.users);
    const managers = owner.escalation.complianceManagerIds;
    // staff reminder recipients: the owner, or (unowned task) the compliance managers so it is never silently dropped
    const staffRecipients = owner.ownerId ? [owner.ownerId] : managers;

    /* ----- upcoming: offsets (at most ONE send per task per day per audience) ----- */
    if (compareDates(task.today, task.dueDate) <= 0) {
      const offsets = offsetsFor(task, input.offsets, input.offsetsByTaskType);

      // staff — `in_app` is the primary channel; its key decides which offsets are already handled
      if (staffRecipients.length) {
        const handled = new Set(offsets.filter((o) => input.existingKeys.has(keyOf("in_app", o, "staff"))));
        const d = decideReminder({ dueDate: task.dueDate, today: task.today, offsets, alreadyHandled: handled });
        for (const o of d.skipped) {
          out.push({
            ...base, mode: "skip", kind: "reminder", key: keyOf("in_app", o, "staff"), channel: "in_app", audience: "staff", offset: String(o),
            templateKey: "staff.reminder", recipientIds: staffRecipients, payload: { subject: "", title: "", body: "", link },
          });
        }
        if (d.send !== null) {
          const msg = renderStaffReminder({ taskTitle: task.title, candidateName: cand?.name, dueDate: task.dueDate, offset: d.send, link });
          for (const channel of staffChannels) {
            const key = keyOf(channel, d.send, "staff");
            if (input.existingKeys.has(key)) continue;
            out.push({
              ...base, mode: "send", kind: "reminder", key, channel, audience: "staff", offset: String(d.send),
              templateKey: msg.templateKey, recipientIds: staffRecipients,
              payload: { subject: msg.subject, title: msg.title, body: msg.body, link: msg.link },
            });
          }
        }
      }

      // candidate-facing — separate template + log; OFF unless enabled; only for candidates that have an email
      if (input.candidateEmailEnabled && cand?.email && isCandidateFacing(task)) {
        const handled = new Set(offsets.filter((o) => input.existingKeys.has(keyOf("email", o, "candidate"))));
        const d = decideReminder({ dueDate: task.dueDate, today: task.today, offsets, alreadyHandled: handled });
        for (const o of d.skipped) {
          out.push({
            ...base, mode: "skip", kind: "reminder", key: keyOf("email", o, "candidate"), channel: "email", audience: "candidate", offset: String(o),
            templateKey: "candidate.reminder", recipientIds: [], toEmail: cand.email, payload: { subject: "", title: "", body: "", link: "" },
          });
        }
        if (d.send !== null) {
          const msg = renderCandidateReminder({ candidateName: cand.name, taskTitle: task.title, dueDate: task.dueDate, offset: d.send });
          out.push({
            ...base, mode: "send", kind: "reminder", key: keyOf("email", d.send, "candidate"), channel: "email", audience: "candidate",
            offset: String(d.send), templateKey: msg.templateKey, recipientIds: [], toEmail: cand.email,
            payload: { subject: msg.subject, title: msg.title, body: msg.body, link: msg.link },
          });
        }
      }
      continue;
    }

    /* ----- overdue: escalation ladder, each level notified ONCE ----- */
    const level = escalationLevel(task.dueDate, task.today, holidays);
    for (let l = 0 as EscalationLevel; l <= level; l = (l + 1) as EscalationLevel) {
      const offset = `overdue-L${l}` as const;
      if (input.existingKeys.has(keyOf("in_app", offset, "staff"))) continue;
      if (l < level) {
        // a lower rung we never got to (worker down / task went overdue over a weekend): record, don't send a stale notice
        out.push({
          ...base, mode: "skip", kind: "escalation", level: l, key: keyOf("in_app", offset, "staff"), channel: "in_app", audience: "staff",
          offset, templateKey: "staff.escalation", recipientIds: [], payload: { subject: "", title: "", body: "", link },
        });
        continue;
      }
      const rec = escalationRecipients(l, owner.escalation);
      if (!rec.userIds.length) continue;
      const msg = renderEscalation({ taskTitle: task.title, candidateName: cand?.name, dueDate: task.dueDate, level: l, link });
      for (const channel of staffChannels) {
        const key = keyOf(channel, offset, "staff");
        if (input.existingKeys.has(key)) continue;
        out.push({
          ...base, mode: "send", kind: "escalation", level: l, key, channel, audience: "staff", offset,
          templateKey: msg.templateKey, recipientIds: rec.userIds,
          payload: { subject: msg.subject, title: msg.title, body: msg.body, link: msg.link },
        });
      }
    }
  }
  return out;
}
