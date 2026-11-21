"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, FormAlert, Input, Select, SubmitButton, Textarea } from "@/components/ui/form";
import type { CommandSpec } from "@/lib/payments/ui";
import { paymentCommandAction, type PaymentFormState } from "@/app/(app)/payments/actions";

function CommandDialog({ paymentId, spec }: { paymentId: string; spec: CommandSpec }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<PaymentFormState, FormData>(paymentCommandAction, {});
  const fe = state.fieldErrors ?? {};

  useEffect(() => {
    if (state.saved && !state.message?.startsWith("Approval recorded")) setOpen(false);
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant={spec.variant ?? "outline"}>
          {spec.label}
        </Button>
      </DialogTrigger>
      <DialogContent title={spec.label} description={spec.description}>
        <form action={action} className="space-y-4">
          <input type="hidden" name="id" value={paymentId} />
          <input type="hidden" name="command" value={spec.command} />
          <FormAlert error={state.error} message={state.saved ? state.message : undefined} />
          {spec.fields.map((f) => (
            <Field key={f.name} label={f.label} htmlFor={`${spec.command}-${f.name}`} required={f.required} hint={f.hint} error={fe[f.name]}>
              {f.kind === "textarea" ? (
                <Textarea id={`${spec.command}-${f.name}`} name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue} maxLength={500} />
              ) : f.kind === "select" ? (
                <Select id={`${spec.command}-${f.name}`} name={f.name} defaultValue={f.defaultValue ?? f.options?.[0]?.value} required={f.required}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id={`${spec.command}-${f.name}`}
                  name={f.name}
                  type={f.kind === "date" ? "date" : "text"}
                  inputMode={f.kind === "amount" ? "decimal" : undefined}
                  required={f.required}
                  placeholder={f.placeholder}
                  defaultValue={f.defaultValue}
                  autoComplete="off"
                />
              )}
            </Field>
          ))}
          <div className="flex justify-end gap-2">
            <SubmitButton variant={spec.variant === "danger" ? "danger" : "primary"} pendingText="Working…">
              {spec.confirmLabel ?? spec.label}
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The workflow actions offered to the current viewer (the server only passes ones they may perform right now). */
export function CommandMenu({ paymentId, commands }: { paymentId: string; commands: CommandSpec[] }) {
  if (commands.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {commands.map((c) => (
        <CommandDialog key={c.command} paymentId={paymentId} spec={c} />
      ))}
    </div>
  );
}
