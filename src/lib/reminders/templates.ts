import { formatDate } from "@/lib/compliance/dates";
import { ESCALATION_LABELS, type EscalationLevel } from "@/lib/reminders/engine";

/**
 * Message templates. Candidate-facing and internal staff messages are SEPARATE templates (long spec §6) with their own
 * template keys, so each audience is logged separately. Candidate messages never contain internal ladder / risk details.
 */

export interface RenderedMessage {
  templateKey: "staff.reminder" | "staff.escalation" | "candidate.reminder";
  subject: string;
  title: string;
  body: string;
  link: string;
}

export const dueWording = (offset: number) => (offset === 0 ? "due today" : offset === 1 ? "due tomorrow" : `due in ${offset} days`);

export function renderStaffReminder(p: { taskTitle: string; candidateName?: string; dueDate: string; offset: number; link: string }): RenderedMessage {
  const who = p.candidateName ? ` — ${p.candidateName}` : "";
  const title = `${p.taskTitle}${who}: ${dueWording(p.offset)}`;
  return {
    templateKey: "staff.reminder",
    subject: `[Compliance CRM] ${title}`,
    title,
    body: `Task "${p.taskTitle}"${who} is ${dueWording(p.offset)} (${formatDate(p.dueDate)}). This is an internal operational reminder; confirm official deadlines with the DSO / counsel.`,
    link: p.link,
  };
}

export function renderEscalation(p: {
  taskTitle: string;
  candidateName?: string;
  dueDate: string;
  level: EscalationLevel;
  link: string;
}): RenderedMessage {
  const who = p.candidateName ? ` — ${p.candidateName}` : "";
  const target = ESCALATION_LABELS[p.level];
  const title = p.level === 0 ? `Overdue: ${p.taskTitle}${who}` : `Escalated to ${target}: ${p.taskTitle}${who} is overdue`;
  return {
    templateKey: "staff.escalation",
    subject: `[Compliance CRM] ${title}`,
    title,
    body: `Task "${p.taskTitle}"${who} was due ${formatDate(p.dueDate)} and is still open${
      p.level > 0 ? `; it has been escalated to the ${target} per the overdue ladder` : ""
    }. Open the task to complete it, record a waiver, or snooze it with a reason.`,
    link: p.link,
  };
}

export function renderCandidateReminder(p: { candidateName?: string; taskTitle: string; dueDate: string; offset: number }): RenderedMessage {
  const greeting = p.candidateName ? `Hello ${p.candidateName.split(/\s+/)[0]},` : "Hello,";
  return {
    templateKey: "candidate.reminder",
    subject: `Action needed: ${p.taskTitle} (${dueWording(p.offset)})`,
    title: `Action needed: ${p.taskTitle}`,
    body: `${greeting}\n\nThis is a reminder that "${p.taskTitle}" is ${dueWording(p.offset)} (${formatDate(p.dueDate)}). Please reply to your compliance contact with the requested information or documents.\n\nIf you have already sent this, thank you — you can ignore this message.`,
    link: "",
  };
}
