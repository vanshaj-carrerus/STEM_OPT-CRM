"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, FormAlert, Input, Select, SubmitButton, Textarea } from "@/components/ui/form";
import { addDays } from "@/lib/compliance/dates";
import { MANUAL_STATUSES, STATUS_LABELS } from "@/lib/tasks/lifecycle";
import {
  completeTaskAction,
  createTaskAction,
  noteTaskAction,
  reassignTaskAction,
  snoozeTaskAction,
  statusTaskAction,
  toggleChecklistAction,
  waiveTaskAction,
  type TaskFormState,
} from "./actions";

export interface ActionTask {
  id: string;
  title: string;
  status: string;
  dueDate: string;
  ownerId: string | null;
  checklist: { label: string; done: boolean }[];
  requiresEvidence: boolean;
}

export interface OwnerOption {
  id: string;
  name: string;
}

type Action = (prev: TaskFormState, fd: FormData) => Promise<TaskFormState>;

function FormDialog({
  label,
  title,
  description,
  action,
  hidden,
  submitLabel,
  pendingText,
  variant = "outline",
  size = "sm",
  icon,
  children,
}: {
  label: string;
  title: string;
  description?: string;
  action: Action;
  hidden: Record<string, string>;
  submitLabel: string;
  pendingText?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<TaskFormState, FormData>(action, {});
  useEffect(() => {
    if (state.saved) setOpen(false);
  }, [state]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size}>
          {icon}
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent title={title} description={description}>
        <form action={formAction} className="space-y-3">
          {Object.entries(hidden).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <FormAlert error={state.error} />
          {children}
          <div className="flex justify-end pt-1">
            <SubmitButton pendingText={pendingText ?? "Saving…"}>{submitLabel}</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Complete / snooze / waive / reassign / note / status for one task. The server re-checks every permission. */
export function TaskActions({ task, owners, canEdit }: { task: ActionTask; owners: OwnerOption[]; canEdit: boolean }) {
  const open = ["open", "in_progress", "waiting_candidate", "waiting_employer", "waiting_dso"].includes(task.status);
  const unfinished = task.checklist.some((c) => !c.done);
  const [pending, start] = useTransition();
  const [statusError, setStatusError] = useState<string | undefined>();
  if (!canEdit) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {open && (
        <>
          <FormDialog
            label="Complete"
            title="Complete task"
            description={task.title}
            action={completeTaskAction}
            hidden={{ id: task.id }}
            submitLabel="Mark complete"
            variant="primary"
          >
            <Field label="Outcome" htmlFor={`o-${task.id}`} required>
              <Textarea id={`o-${task.id}`} name="outcome" required rows={2} maxLength={2000} placeholder="What was the result?" />
            </Field>
            <Field label="Evidence note" htmlFor={`e-${task.id}`} required={task.requiresEvidence} hint="Describe the evidence (e.g. where the confirmation is filed).">
              <Textarea id={`e-${task.id}`} name="evidenceNote" rows={2} maxLength={4000} />
            </Field>
            <Field label="Document ID (optional)" htmlFor={`d-${task.id}`} hint="Link a document from this candidate's vault.">
              <Input id={`d-${task.id}`} name="documentId" maxLength={100} />
            </Field>
            {unfinished && (
              <Field
                label="Waiver reason for unfinished checklist items"
                htmlFor={`w-${task.id}`}
                hint="Required because some checklist items are not ticked."
              >
                <Textarea id={`w-${task.id}`} name="checklistWaiverReason" rows={2} maxLength={2000} />
              </Field>
            )}
          </FormDialog>

          <FormDialog
            label="Snooze"
            title="Snooze task"
            description="Pushes the due date later. The original due date and this history are kept."
            action={snoozeTaskAction}
            hidden={{ id: task.id }}
            submitLabel="Snooze"
          >
            <Field label="New due date" htmlFor={`n-${task.id}`} required>
              <Input id={`n-${task.id}`} type="date" name="newDueDate" required min={addDays(task.dueDate, 1)} />
            </Field>
            <Field label="Reason" htmlFor={`r-${task.id}`} required>
              <Textarea id={`r-${task.id}`} name="reason" required rows={2} maxLength={2000} />
            </Field>
          </FormDialog>

          <FormDialog
            label="Waive"
            title="Waive task"
            description="Marks the task as not required. A reason is mandatory and audit-logged."
            action={waiveTaskAction}
            hidden={{ id: task.id }}
            submitLabel="Waive task"
            variant="outline"
          >
            <Field label="Reason" htmlFor={`wr-${task.id}`} required>
              <Textarea id={`wr-${task.id}`} name="reason" required rows={3} maxLength={2000} />
            </Field>
          </FormDialog>
        </>
      )}

      <FormDialog
        label="Note"
        title="Add note"
        description={task.title}
        action={noteTaskAction}
        hidden={{ id: task.id }}
        submitLabel="Add note"
        variant="ghost"
      >
        <Textarea name="text" required rows={3} maxLength={4000} placeholder="Add a note…" />
      </FormDialog>

      {open && owners.length > 0 && (
        <FormDialog
          label="Reassign"
          title="Reassign task"
          description={task.title}
          action={reassignTaskAction}
          hidden={{ id: task.id }}
          submitLabel="Reassign"
          variant="ghost"
        >
          <Field label="New owner" htmlFor={`ro-${task.id}`}>
            <Select id={`ro-${task.id}`} name="ownerId" defaultValue={task.ownerId ?? ""}>
              <option value="">Unassigned</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        </FormDialog>
      )}

      {open && (
        <span className="inline-flex flex-col">
          <Select
            aria-label="Change status"
            className="h-8 w-44 text-xs"
            value={task.status}
            disabled={pending}
            onChange={(e) => {
              const fd = new FormData();
              fd.set("id", task.id);
              fd.set("status", e.target.value);
              start(async () => {
                const res = await statusTaskAction({}, fd);
                setStatusError(res.error);
              });
            }}
          >
            {MANUAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          {statusError && <span className="text-xs text-danger">{statusError}</span>}
        </span>
      )}
    </div>
  );
}

/** Tickable checklist. Optimistic locally; the server action re-checks permission and persists + audits. */
export function Checklist({ taskId, items, editable }: { taskId: string; items: { label: string; done: boolean }[]; editable: boolean }) {
  const [state, setState] = useState(items);
  const [error, setError] = useState<string | undefined>();
  const [, start] = useTransition();
  useEffect(() => setState(items), [items]);
  return (
    <div>
      <ul className="space-y-1">
        {state.map((c, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={c.done}
              disabled={!editable}
              onChange={(e) => {
                const done = e.target.checked;
                const prev = state;
                setState(state.map((x, j) => (j === i ? { ...x, done } : x)));
                start(async () => {
                  const res = await toggleChecklistAction(taskId, i, done);
                  if (res.error) {
                    setState(prev);
                    setError(res.error);
                  } else setError(undefined);
                });
              }}
            />
            <span className={c.done ? "text-muted-foreground line-through" : ""}>{c.label}</span>
          </li>
        ))}
      </ul>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** "New task" dialog (staff with tasks.edit). candidateId optional: omit for a general task. */
export function NewTaskDialog({ candidateId, owners }: { candidateId?: string; owners: OwnerOption[] }) {
  return (
    <FormDialog
      label="New task"
      title="New task"
      action={createTaskAction}
      hidden={candidateId ? { candidateId } : {}}
      submitLabel="Create task"
      variant="primary"
      icon={<Plus className="h-4 w-4" />}
    >
      <Field label="Title" htmlFor="nt-title" required>
        <Input id="nt-title" name="title" required minLength={3} maxLength={200} />
      </Field>
      <Field label="Description" htmlFor="nt-desc">
        <Textarea id="nt-desc" name="description" rows={2} maxLength={4000} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Due date" htmlFor="nt-due" required>
          <Input id="nt-due" type="date" name="dueDate" required />
        </Field>
        <Field label="Priority" htmlFor="nt-pri">
          <Select id="nt-pri" name="priority" defaultValue="normal">
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
        </Field>
      </div>
      <Field label="Owner" htmlFor="nt-owner">
        <Select id="nt-owner" name="ownerId" defaultValue="">
          <option value="">Me</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>
    </FormDialog>
  );
}
