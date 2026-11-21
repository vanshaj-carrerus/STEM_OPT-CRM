"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordResetAction, resetPasswordAction, type FormState } from "@/lib/auth/actions";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form";

export function ForgotForm() {
  const [req, reqAction] = useActionState<FormState, FormData>(requestPasswordResetAction, {});
  const [reset, resetAction] = useActionState<FormState, FormData>(resetPasswordAction, {});
  const email = reset.email ?? req.email;
  const showReset = req.step === "reset" || reset.step === "reset";

  if (!showReset) {
    return (
      <form action={reqAction} className="space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Reset your password</h1>
          <p className="text-xs text-muted-foreground">Enter your work email and we&apos;ll send a verification code.</p>
        </div>
        <FormAlert error={req.error} />
        <Field label="Work email" htmlFor="email">
          <Input id="email" name="email" type="email" required autoFocus />
        </Field>
        <SubmitButton className="w-full" pendingText="Sending…">
          Send code
        </SubmitButton>
        <p className="text-center text-xs">
          <Link href="/login" className="text-primary hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    );
  }

  return (
    <form action={resetAction} className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Enter code &amp; new password</h1>
        <p className="text-xs text-muted-foreground">Staff accounts need 12+ characters with upper/lower case, a number and a symbol (not required for the system admin).</p>
      </div>
      <FormAlert error={reset.error} message={reset.error ? undefined : req.message} />
      <input type="hidden" name="email" value={email ?? ""} />
      <Field label="Verification code" htmlFor="code">
        <Input id="code" name="code" inputMode="numeric" maxLength={6} pattern="\d{6}" required autoFocus className="font-mono tracking-widest" />
      </Field>
      <Field label="New password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="new-password" required />
      </Field>
      <SubmitButton className="w-full" pendingText="Updating…">
        Update password
      </SubmitButton>
    </form>
  );
}
