import { addDays, businessDaysBetween, compareDates, diffDays, type DateOnly } from "@/lib/compliance/dates";

/** Default internal reminder offsets, days before due date (0 = due date). Admin can override per task type. */
export const DEFAULT_OFFSETS = [30, 14, 7, 3, 1, 0] as const;

export type Channel = "in_app" | "email";
export type Audience = "staff" | "candidate"; // separate templates + logs (long spec §6)

/** Unique key preventing duplicate reminders: candidate + task type + due date + channel + offset (AC-08). */
export function reminderKey(p: {
  candidateId: string;
  taskType: string;
  dueDate: DateOnly;
  channel: Channel;
  offset: number | "overdue" | `overdue-L${number}`;
  audience?: Audience;
}): string {
  return [p.candidateId, p.taskType, p.dueDate, p.channel, String(p.offset), p.audience ?? "staff"].join("|");
}

export interface ReminderDecision {
  /** Offset to send now, or null if nothing is due today. */
  send: number | null;
  /** Earlier offsets that were missed (task created late / worker down) — recorded as skipped, never sent in a burst. */
  skipped: number[];
}

/**
 * Decide which reminder (at most ONE) should go out today.
 * - An offset becomes eligible on (dueDate - offset).
 * - If several are eligible and unsent (e.g. task created 5 days before due), only the most urgent one is sent
 *   and the less-urgent earlier ones are marked skipped, so the user never gets a burst of stale reminders.
 * - Nothing is sent once the due date has passed — overdue handling is the escalation ladder's job.
 */
export function decideReminder(p: {
  dueDate: DateOnly;
  today: DateOnly;
  offsets?: readonly number[];
  alreadyHandled: ReadonlySet<number>; // offsets already sent or skipped
}): ReminderDecision {
  const offsets = [...(p.offsets ?? DEFAULT_OFFSETS)].sort((a, b) => b - a); // 30,14,7,3,1,0
  if (compareDates(p.today, p.dueDate) > 0) return { send: null, skipped: [] };
  const eligible = offsets.filter((o) => compareDates(addDays(p.dueDate, -o), p.today) <= 0 && !p.alreadyHandled.has(o));
  if (eligible.length === 0) return { send: null, skipped: [] };
  const send = eligible[eligible.length - 1]; // smallest offset = closest to due date = most urgent
  return { send, skipped: eligible.slice(0, -1) };
}

/* ----------------------------- Escalation ----------------------------- */

export type EscalationLevel = 0 | 1 | 2 | 3;
export const ESCALATION_LABELS = ["owner", "team lead", "compliance manager", "department admin"] as const;

/**
 * Overdue escalation ladder (long spec §6): owner → team lead after 1 business day →
 * compliance manager after 3 business days → department admin after 5 business days.
 * Level 0 also covers "not overdue".
 */
export function escalationLevel(dueDate: DateOnly, today: DateOnly, holidays: ReadonlySet<DateOnly> = new Set()): EscalationLevel {
  const bd = businessDaysBetween(dueDate, today, holidays);
  if (bd >= 5) return 3;
  if (bd >= 3) return 2;
  if (bd >= 1) return 1;
  return 0;
}

export interface EscalationUsers {
  ownerId?: string | null;
  teamLeadId?: string | null;
  complianceManagerIds: string[];
  adminIds: string[];
}

/** Who must be notified at a given level. Falls back upward if a level has nobody (never silently drops). */
export function escalationRecipients(level: EscalationLevel, u: EscalationUsers): { level: EscalationLevel; userIds: string[] } {
  const byLevel: string[][] = [
    u.ownerId ? [u.ownerId] : [],
    u.teamLeadId ? [u.teamLeadId] : [],
    u.complianceManagerIds,
    u.adminIds,
  ];
  for (let l = level; l <= 3; l++) {
    if (byLevel[l].length) return { level: l as EscalationLevel, userIds: byLevel[l] };
  }
  for (let l = level - 1; l >= 0; l--) {
    if (byLevel[l].length) return { level: l as EscalationLevel, userIds: byLevel[l] };
  }
  return { level, userIds: [] };
}

/* ------------------------------- Snooze ------------------------------- */

export interface SnoozeRequest {
  reason: string;
  currentDueDate: DateOnly;
  newDueDate: DateOnly;
}

/** Snooze only with a reason and a later due date; the ORIGINAL due date and history are preserved by the caller. */
export function validateSnooze(r: SnoozeRequest): { ok: true } | { ok: false; error: string } {
  if (!r.reason || r.reason.trim().length < 3) return { ok: false, error: "A reason is required to snooze." };
  if (compareDates(r.newDueDate, r.currentDueDate) <= 0) return { ok: false, error: "The new due date must be after the current due date." };
  if (diffDays(r.newDueDate, r.currentDueDate) > 90) return { ok: false, error: "Snoozing more than 90 days requires manager review." };
  return { ok: true };
}
