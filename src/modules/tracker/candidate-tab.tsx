import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { loadCandidateFor } from "@/lib/auth/guard";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";
import { formatDate, todayIn } from "@/lib/compliance/dates";
import { isOverdue } from "@/lib/tasks/calendar";
import { EVIDENCE_REQUIRED } from "@/lib/tasks/lifecycle";
import { defaultAnchorFor } from "@/lib/tracker/cycle";
import { loadTracker } from "@/lib/tracker/service";
import { DEFAULT_TIMEZONE, isValidTimezone, resolveTimezone } from "@/lib/reminders/timezone";
import { listAssignableUsers, userNameMap } from "@/lib/users/directory";
import type { CandidateTabProps } from "../tab-types";
import { Checklist, TaskActions } from "../tasks/task-actions";
import { DueDate, TaskHistory, TaskStatusBadge } from "../tasks/task-ui";
import { CloseCycleForm, StartCycleForm } from "./tracker-forms";

const DONE = ["completed", "waived"];

/**
 * 12-month operational tracker. An internal review aid: it does NOT replace official DSO / SEVIS reporting.
 * Server-rendered; every mutation goes through server actions that re-check permission + record access.
 */
export async function CandidateTrackerTab({ candidateId }: CandidateTabProps) {
  const user = await getSessionUser();
  if (!user || !can(user, "tracker.view")) {
    return (
      <Card>
        <CardBody className="text-sm text-muted-foreground">You do not have permission to view the 12-month tracker.</CardBody>
      </Card>
    );
  }
  const candidate = await loadCandidateFor(user, candidateId);
  if (!candidate) notFound();

  const canEdit = can(user, "tracker.edit");
  const canSignoff = can(user, "tracker.signoff");
  const cycles = await loadTracker(candidateId);
  const today = todayIn(isValidTimezone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE);
  const ids = cycles.flatMap((c) => [
    c.cycle.anchorChosenBy, c.cycle.closedBy, c.cycle.startedBy,
    ...c.months.flatMap((m) => [m.task?.ownerId, m.task?.completedBy, ...(m.task?.notes.map((n) => n.by) ?? []), ...(m.task?.evidence.map((e) => e.by) ?? []), ...(m.task?.snoozes.map((s) => s.by) ?? [])]),
  ]);
  const [names, owners] = await Promise.all([userNameMap(ids), listAssignableUsers()]);
  const ownerOptions = owners.map((o) => ({ id: o.id, name: o.name }));
  const open = cycles.find((c) => c.cycle.status === "open");
  const hasClosed = cycles.some((c) => c.cycle.status === "closed");
  const defaultAnchor = defaultAnchorFor(candidate, resolveTimezone(candidate.timezone, user.timezone));

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        The 12-month tracker is an internal operational review. It does not replace official DSO / SEVIS reporting; confirm requirements with the DSO or counsel.
      </p>

      {!open && canEdit && (
        <Card>
          <CardHeader
            title={hasClosed ? "Start the next cycle" : "Start a 12-month cycle"}
            description={hasClosed ? "The previous cycle is closed. A manager starts the next one (or enable automatic next cycles in settings)." : "No cycle has been started for this candidate yet."}
          />
          <CardBody>
            {hasClosed && !canSignoff ? (
              <p className="text-sm text-muted-foreground">Only a manager with sign-off permission can start the next cycle.</p>
            ) : (
              <StartCycleForm candidateId={candidateId} defaultAnchor={defaultAnchor} canChooseAnchor={canSignoff} label={hasClosed ? "Start next cycle" : "Start cycle"} />
            )}
          </CardBody>
        </Card>
      )}
      {!open && !canEdit && cycles.length === 0 && (
        <Card>
          <CardBody className="text-sm text-muted-foreground">No 12-month cycle has been started for this candidate.</CardBody>
        </Card>
      )}

      {cycles.map(({ cycle, months }) => {
        const finished = months.filter((m) => DONE.includes(m.review.status)).length;
        const isOpen = cycle.status === "open";
        return (
          <Card key={cycle._id}>
            <CardHeader
              title={`Cycle ${cycle.cycleNumber} · anchored ${formatDate(cycle.anchorDate)}`}
              description={`Anchor reason: ${cycle.anchorReason}${cycle.anchorChosenBy ? ` (chosen by ${names[cycle.anchorChosenBy] ?? "a manager"})` : ""}`}
              action={
                <div className="flex items-center gap-2">
                  <Badge tone={isOpen ? "info" : "success"}>{isOpen ? "Open" : "Closed"}</Badge>
                  <Badge tone="neutral">{finished}/12 finished</Badge>
                </div>
              }
            />
            <CardBody className="space-y-3">
              {!isOpen && cycle.closedAt && (
                <p className="text-xs text-muted-foreground">
                  Signed off by {cycle.closedBy ? (names[cycle.closedBy] ?? "manager") : "manager"} on {formatDate(cycle.closedAt.toISOString().slice(0, 10))}
                  {cycle.closeNote ? `: ${cycle.closeNote}` : ""}
                </p>
              )}
              <ul className="space-y-3">
                {months.map(({ review, task }) => {
                  if (!task) return null;
                  const overdue = isOverdue(task.status, task.dueDate, today);
                  const openTask = !DONE.includes(task.status) && task.status !== "cancelled";
                  return (
                    <li key={review._id} className={`rounded-md border p-4 ${overdue ? "border-danger/40 bg-danger-bg/30" : ""}`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-sm font-semibold">Month {review.monthNumber}</h4>
                            <TaskStatusBadge status={task.status} />
                            {overdue && <Badge tone="danger">Overdue</Badge>}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">Owner: {task.ownerId ? (names[task.ownerId] ?? "—") : "Unassigned"}</p>
                        </div>
                        <div className="text-right text-sm">
                          <p className="text-xs text-muted-foreground">Due</p>
                          <DueDate task={task} today={today} />
                        </div>
                      </div>
                      <div className="mt-3">
                        <Checklist taskId={task._id} items={task.checklist.map((c) => ({ label: c.label, done: !!c.done }))} editable={canEdit && isOpen && openTask} />
                      </div>
                      <TaskHistory task={task} names={names} />
                      {isOpen && canEdit && (
                        <div className="mt-3">
                          <TaskActions
                            task={{
                              id: task._id, title: task.title, status: task.status, dueDate: task.dueDate, ownerId: task.ownerId ?? null,
                              checklist: task.checklist.map((c) => ({ label: c.label, done: !!c.done })),
                              requiresEvidence: EVIDENCE_REQUIRED(task.kind),
                            }}
                            owners={ownerOptions}
                            canEdit
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {isOpen && canSignoff && (
                <div className="border-t pt-4">
                  <h4 className="mb-2 text-sm font-semibold">Manager sign-off (month 12)</h4>
                  {finished === 12 ? (
                    <CloseCycleForm candidateId={candidateId} cycleId={cycle._id} />
                  ) : (
                    <p className="text-xs text-muted-foreground">All 12 months must be completed or waived before the cycle can be closed.</p>
                  )}
                </div>
              )}
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
