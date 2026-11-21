"use client";

import { useActionState } from "react";
import { changePasswordAction, type FormState } from "@/lib/auth/actions";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form";

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const [state, action] = useActionState<FormState, FormData>(changePasswordAction, {});
  return (
    <form action={action} className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{forced ? "Set a new password" : "Change password"}</h1>
        <p className="text-xs text-muted-foreground">
          {forced ? "Your administrator requires you to choose a new password before continuing." : "Choose a strong password you don't use elsewhere."}
        </p>
      </div>
      <FormAlert error={state.error} />
      <Field label="Current password" htmlFor="current">
        <Input id="current" name="current" type="password" autoComplete="current-password" required />
      </Field>
      <Field label="New password" htmlFor="password" hint="Staff accounts need 12+ characters with upper/lower case, a number and a symbol (not required for the system admin).">
        <Input id="password" name="password" type="password" autoComplete="new-password" required />
      </Field>
      <SubmitButton className="w-full" pendingText="Saving…">
        Update password
      </SubmitButton>
    </form>
  );
}
