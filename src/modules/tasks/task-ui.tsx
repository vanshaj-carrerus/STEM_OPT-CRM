import { AlertTriangle, History } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { formatDate } from "@/lib/compliance/dates";
import { isOverdue } from "@/lib/tasks/calendar";
import { EVIDENCE_REQUIRED, STATUS_LABELS } from "@/lib/tasks/lifecycle";
import type { ITask, TaskStatus } from "@/lib/db/models/task";
import { Checklist, TaskActions, type OwnerOption } from "./task-actions";

export const STATUS_TONE: Record<TaskStatus, Tone> = {
  open: "neutral",
  in_progress: "info",
  waiting_candidate: "warning",
  waiting_employer: "warning",
  waiting_dso: "warning",
  completed: "success",
  waived: "neutral",
  cancelled: "neutral",
};

export const KIND_LABELS: Record<string, string> = {
  milestone: "Milestone",
  monthly_review: "Monthly review",
  change_review: "Change review",
  document_request: "Document request",
  unemployment_check: "Unemployment check",
  payroll: "Payroll",
  payment: "Payment",
  manual: "Manual",
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>;
}

/** Due date with overdue highlighting; shows the original date when the task was snoozed. */
export function DueDate({ task, today }: { task: Pick<ITask, "status" | "dueDate" | "originalDueDate">; today: string }) {
  const overdue = isOverdue(task.status, task.dueDate, today);
  return (
    <div className="leading-tight">
      <span className={overdue ? "inline-flex items-center gap-1 font-medium text-danger" : ""}>
        {overdue && <AlertTriangle className="h-3.5 w-3.5" aria-label="Overdue" />}
        {formatDate(task.dueDate)}
      </span>
      {task.originalDueDate !== task.dueDate && (
        <p className="text-xs text-muted-foreground">originally {formatDate(task.originalDueDate)}</p>
      )}
    </div>
  );
}

/** Notes, evidence, snooze + completion history, rendered server-side (no client JS needed). */
export function TaskHistory({ task, names }: { task: ITask; names: Record<string, string> }) {
  const lines: { at: Date; text: string }[] = [
    ...task.snoozes.map((s) => ({ at: s.at, text: `Snoozed ${formatDate(s.from)} → ${formatDate(s.to)} by ${names[s.by] ?? "user"}: ${s.reason}` })),
    ...task.notes.map((n) => ({ at: n.at, text: `Note by ${n.byName ?? names[n.by] ?? "user"}: ${n.text}` })),
    ...task.evidence.map((e) => ({
      at: e.at,
      text: `Evidence by ${names[e.by] ?? "user"}${e.documentId ? ` (document ${e.documentId})` : ""}${e.note ? `: ${e.note}` : ""}`,
    })),
  ];
  if (task.status === "completed" && task.completedAt) {
    lines.push({ at: task.completedAt, text: `Completed by ${task.completedBy ? (names[task.completedBy] ?? "user") : "user"}. Outcome: ${task.outcome ?? "—"}` });
  }
  if (task.status === "waived" && task.completedAt) {
    lines.push({ at: task.completedAt, text: `Waived by ${task.completedBy ? (names[task.completedBy] ?? "user") : "user"}: ${task.waivedReason ?? "—"}` });
  }
  if (task.status === "cancelled") lines.push({ at: task.updatedAt, text: `Cancelled: ${task.cancelledReason ?? "no longer required"}` });
  if (!lines.length) return null;
  lines.sort((a, b) => a.at.getTime() - b.at.getTime());
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground">
        <History className="h-3 w-3" /> History ({lines.length})
      </summary>
      <ul className="mt-1.5 space-y-1 border-l pl-3">
        {lines.map((l, i) => (
          <li key={i}>
            <span className="tabular-nums">{l.at.toISOString().slice(0, 16).replace("T", " ")} UTC</span> — {l.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function TaskItem({
  task, today, names, owners, canEdit, showKind = true,
}: {
  task: ITask;
  today: string;
  names: Record<string, string>;
  owners: OwnerOption[];
  canEdit: boolean;
  showKind?: boolean;
}) {
  const open = ["open", "in_progress", "waiting_candidate", "waiting_employer", "waiting_dso"].includes(task.status);
  const overdue = isOverdue(task.status, task.dueDate, today);
  return (
    <li className={`rounded-md border p-4 ${overdue ? "border-danger/40 bg-danger-bg/30" : "bg-card"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">{task.title}</h4>
            <TaskStatusBadge status={task.status} />
            {showKind && <Badge tone="primary">{KIND_LABELS[task.kind] ?? task.kind}</Badge>}
            {task.priority !== "normal" && <Badge tone={task.priority === "low" ? "neutral" : "warning"}>{task.priority}</Badge>}
            {overdue && <Badge tone="danger">Overdue</Badge>}
          </div>
          {task.description && <p className="mt-1 text-xs text-muted-foreground">{task.description}</p>}
          <p className="mt-1 text-xs text-muted-foreground">
            Owner: {task.ownerId ? (names[task.ownerId] ?? "—") : "Unassigned"}
          </p>
        </div>
        <div className="text-right text-sm">
          <p className="text-xs text-muted-foreground">Due</p>
          <DueDate task={task} today={today} />
        </div>
      </div>
      {task.checklist.length > 0 && (
        <div className="mt-3">
          <Checklist taskId={task._id} items={task.checklist} editable={canEdit && open} />
        </div>
      )}
      <TaskHistory task={task} names={names} />
      {canEdit && (
        <div className="mt-3">
          <TaskActions
            task={{
              id: task._id, title: task.title, status: task.status, dueDate: task.dueDate, ownerId: task.ownerId ?? null,
              checklist: task.checklist.map((c) => ({ label: c.label, done: !!c.done })),
              requiresEvidence: EVIDENCE_REQUIRED(task.kind),
            }}
            owners={owners}
            canEdit
          />
        </div>
      )}
    </li>
  );
}
