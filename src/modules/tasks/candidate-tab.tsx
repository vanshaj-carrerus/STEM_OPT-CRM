import { notFound } from "next/navigation";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { loadCandidateFor } from "@/lib/auth/guard";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";
import { todayIn } from "@/lib/compliance/dates";
import { isValidTimezone, DEFAULT_TIMEZONE } from "@/lib/reminders/timezone";
import { candidateTasksDetail } from "@/lib/tasks/queries";
import { listAssignableUsers, userNameMap } from "@/lib/users/directory";
import type { CandidateTabProps } from "../tab-types";
import { NewTaskDialog } from "./task-actions";
import { TaskItem } from "./task-ui";

/** Candidate "Tasks" tab: milestones, change reviews, document requests and manual tasks (monthly reviews live in the tracker tab). */
export async function CandidateTasksTab({ candidateId }: CandidateTabProps) {
  const user = await getSessionUser();
  if (!user || !can(user, "tasks.view")) {
    return (
      <Card>
        <CardBody className="text-sm text-muted-foreground">You do not have permission to view tasks.</CardBody>
      </Card>
    );
  }
  // record-level access: no access ⇒ 404 (never reveal that the candidate exists)
  if (!(await loadCandidateFor(user, candidateId))) notFound();

  const tasks = await candidateTasksDetail(user, candidateId);
  const userIds = tasks.flatMap((t) => [t.ownerId, t.completedBy, ...t.snoozes.map((s) => s.by), ...t.notes.map((n) => n.by), ...t.evidence.map((e) => e.by)]);
  const [names, owners] = await Promise.all([userNameMap(userIds), listAssignableUsers()]);
  const canEdit = can(user, "tasks.edit");
  const today = todayIn(isValidTimezone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE);
  const ownerOptions = owners.map((o) => ({ id: o.id, name: o.name }));

  return (
    <Card>
      <CardHeader
        title="Tasks"
        description="Compliance milestones, reviews, document requests and manual tasks. Monthly reviews are in the 12-Month Tracker tab."
        action={canEdit ? <NewTaskDialog candidateId={candidateId} owners={ownerOptions} /> : undefined}
      />
      <CardBody>
        {tasks.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No tasks yet for this candidate.</p>
        ) : (
          <ul className="space-y-3">
            {tasks.map((t) => (
              <TaskItem key={t._id} task={t} today={today} names={names} owners={ownerOptions} canEdit={canEdit} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
