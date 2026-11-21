"use client";

import Link from "next/link";
import { useActionState } from "react";
import { loginAction, type FormState } from "@/lib/auth/actions";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form";

export function LoginForm({ resetDone }: { resetDone?: boolean }) {
  const [state, action] = useActionState<FormState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="text-xs text-muted-foreground">We&apos;ll email you a verification code after your password.</p>
      </div>
      {resetDone && <FormAlert message="Password updated. Sign in with your new password." />}
      <FormAlert error={state.error} />
      <Field label="Work email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <SubmitButton className="w-full" pendingText="Signing in…">
        Continue
      </SubmitButton>
      <p className="text-center text-xs">
        <Link href="/forgot-password" className="text-primary hover:underline">
          Forgot password?
        </Link>
      </p>
    </form>
  );
}
