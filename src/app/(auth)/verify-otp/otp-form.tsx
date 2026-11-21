"use client";

import { useActionState, useTransition, useState } from "react";
import { resendOtpAction, verifyOtpAction, type FormState } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form";

export function OtpForm({ email }: { email: string }) {
  const [state, action] = useActionState<FormState, FormData>(verifyOtpAction, {});
  const [pending, start] = useTransition();
  const [resend, setResend] = useState<FormState>({});

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Check your email</h1>
        <p className="text-xs text-muted-foreground">
          We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>. It expires in 10 minutes.
        </p>
      </div>
      <form action={action} className="space-y-4">
        <FormAlert error={state.error ?? resend.error} message={resend.message} />
        <Field label="Verification code" htmlFor="code">
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            className="text-center font-mono text-lg tracking-[0.5em]"
          />
        </Field>
        <SubmitButton className="w-full" pendingText="Verifying…">
          Verify &amp; sign in
        </SubmitButton>
      </form>
      <div className="flex items-center justify-between text-xs">
        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={pending}
          onClick={() => start(async () => setResend(await resendOtpAction()))}
        >
          Resend code
        </Button>
        <a href="/login" className="text-muted-foreground hover:underline">
          Back to sign in
        </a>
      </div>
    </div>
  );
}
