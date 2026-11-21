"use client";

import { useActionState, useEffect, useRef } from "react";
import { FormAlert, SubmitButton } from "@/components/ui/form";
import type { ButtonProps } from "@/components/ui/button";
import type { ActionResult } from "@/lib/payroll/errors";
import { cn } from "@/lib/utils";

/** Generic server-action form: shows the success/error message returned by the action. */
export function ActionForm({
  action,
  children,
  submit,
  pendingText,
  variant = "primary",
  size = "md",
  className,
  reset = false,
  inline = false,
}: {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  children?: React.ReactNode;
  submit: string;
  pendingText?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  reset?: boolean;
  inline?: boolean;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(action, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok && reset) ref.current?.reset();
  }, [state, reset]);
  return (
    <form ref={ref} action={formAction} className={cn(inline ? "flex flex-wrap items-end gap-2" : "space-y-3", className)}>
      <FormAlert error={state.error} message={state.ok ? state.message : undefined} />
      {children}
      <SubmitButton variant={variant} size={size} pendingText={pendingText ?? "Working…"}>
        {submit}
      </SubmitButton>
    </form>
  );
}
