"use client";

import { createContext, useActionState, useContext, useState, useTransition } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, FormAlert, Input, Select, SubmitButton, Textarea } from "@/components/ui/form";
import type { ActionState } from "./action-utils";

const ErrorsContext = createContext<Record<string, string>>({});

/** Fields rendered inside a FormDialog pick up per-field validation errors from the last submit. */
export function TextField({
  name, label, type = "text", required, defaultValue, hint, placeholder, className, maxLength,
}: {
  name: string; label: string; type?: string; required?: boolean; defaultValue?: string | number | null; hint?: string;
  placeholder?: string; className?: string; maxLength?: number;
}) {
  const fe = useContext(ErrorsContext);
  return (
    <Field label={label} htmlFor={name} error={fe[name]} required={required} hint={hint} className={className}>
      <Input id={name} name={name} type={type} required={required} defaultValue={defaultValue ?? ""} placeholder={placeholder} maxLength={maxLength} step={type === "number" ? "any" : undefined} />
    </Field>
  );
}

export function SelectField({
  name, label, options, required, defaultValue, hint, className,
}: {
  name: string; label: string; options: { value: string; label: string }[]; required?: boolean; defaultValue?: string | null; hint?: string; className?: string;
}) {
  const fe = useContext(ErrorsContext);
  return (
    <Field label={label} htmlFor={name} error={fe[name]} required={required} hint={hint} className={className}>
      <Select id={name} name={name} required={required} defaultValue={defaultValue ?? ""}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function TextAreaField({
  name, label, defaultValue, hint, required, rows = 3, className, maxLength,
}: {
  name: string; label: string; defaultValue?: string | null; hint?: string; required?: boolean; rows?: number; className?: string; maxLength?: number;
}) {
  const fe = useContext(ErrorsContext);
  return (
    <Field label={label} htmlFor={name} error={fe[name]} required={required} hint={hint} className={className}>
      <Textarea id={name} name={name} rows={rows} required={required} defaultValue={defaultValue ?? ""} maxLength={maxLength} />
    </Field>
  );
}

function DialogForm({
  action, hidden, submitLabel, submitVariant, onDone, children,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  hidden: Record<string, string>;
  submitLabel: string;
  submitVariant?: ButtonProps["variant"];
  onDone: () => void;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(async (prev, fd) => {
    const r = await action(prev, fd);
    if (r.saved) onDone();
    return r;
  }, {});
  return (
    <ErrorsContext.Provider value={state.fieldErrors ?? {}}>
      <form action={formAction} className="space-y-4">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <FormAlert error={state.error} />
        {state.reasons && state.reasons.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-xs text-danger">
            {state.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {children}
        <div className="flex justify-end">
          <SubmitButton variant={submitVariant} pendingText="Saving…">
            {submitLabel}
          </SubmitButton>
        </div>
      </form>
    </ErrorsContext.Provider>
  );
}

/** Button that opens a dialog containing a server-action form. Closes itself when the action reports `saved`. */
export function FormDialog({
  title, description, triggerLabel, triggerIcon, triggerVariant = "outline", triggerSize = "sm", action, hidden = {},
  submitLabel = "Save", submitVariant, wide, children,
}: {
  title: string;
  description?: string;
  triggerLabel: string;
  triggerIcon?: React.ReactNode;
  triggerVariant?: ButtonProps["variant"];
  triggerSize?: ButtonProps["size"];
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  hidden?: Record<string, string>;
  submitLabel?: string;
  submitVariant?: ButtonProps["variant"];
  wide?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size={triggerSize} type="button">
          {triggerIcon}
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent title={title} description={description} className={wide ? "max-w-2xl" : undefined}>
        <DialogForm action={action} hidden={hidden} submitLabel={submitLabel} submitVariant={submitVariant} onDone={() => setOpen(false)}>
          {children}
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

/** One-click server action with inline error / blocker display and optional confirmation. */
export function ActionButton({
  action, children, variant = "outline", size = "sm", confirm, icon,
}: {
  action: () => Promise<ActionState>;
  children: React.ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  confirm?: string;
  icon?: React.ReactNode;
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState>({});
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          start(async () => setState(await action()));
        }}
      >
        {icon}
        {pending ? "Working…" : children}
      </Button>
      {state.error && <span role="alert" className="max-w-xs text-xs text-danger">{state.error}</span>}
      {state.reasons && state.reasons.length > 0 && (
        <ul role="alert" className="max-w-xs list-disc space-y-0.5 pl-4 text-xs text-danger">
          {state.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {state.message && !state.error && <span role="status" className="max-w-xs text-xs text-success">{state.message}</span>}
    </span>
  );
}
