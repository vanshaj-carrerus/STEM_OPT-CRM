"use client";

import { useActionState, useEffect, useRef } from "react";
import { Field, FormAlert, Input, SubmitButton, Textarea } from "@/components/ui/form";
import { closeCycleAction, startCycleAction, type TrackerFormState } from "./actions";

export function StartCycleForm({ candidateId, defaultAnchor, canChooseAnchor, label }: { candidateId: string; defaultAnchor: string; canChooseAnchor: boolean; label: string }) {
  const [state, action] = useActionState<TrackerFormState, FormData>(startCycleAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.saved) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="space-y-3">
      <input type="hidden" name="candidateId" value={candidateId} />
      <FormAlert error={state.error} />
      {canChooseAnchor ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Anchor date (optional)" htmlFor="anchor" hint={`Default: ${defaultAnchor} (authorization start or onboarding date). Month N is due N months after the anchor.`}>
            <Input id="anchor" type="date" name="anchor" />
          </Field>
          <Field label="Why this anchor? (required if you choose a date)" htmlFor="anchorReason">
            <Textarea id="anchorReason" name="anchorReason" rows={2} maxLength={500} />
          </Field>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">The cycle is anchored to {defaultAnchor} (authorization start or onboarding date). Only a manager can choose a different anchor.</p>
      )}
      <SubmitButton pendingText="Starting…">{label}</SubmitButton>
    </form>
  );
}

export function CloseCycleForm({ candidateId, cycleId }: { candidateId: string; cycleId: string }) {
  const [state, action] = useActionState<TrackerFormState, FormData>(closeCycleAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="candidateId" value={candidateId} />
      <input type="hidden" name="cycleId" value={cycleId} />
      <FormAlert error={state.error} message={state.saved ? state.message : undefined} />
      <Field label="Manager review note" htmlFor={`note-${cycleId}`} required>
        <Textarea id={`note-${cycleId}`} name="note" required rows={2} maxLength={2000} placeholder="Summary of the annual review and decision on the next cycle." />
      </Field>
      <SubmitButton variant="secondary" pendingText="Closing…">
        Sign off and close cycle
      </SubmitButton>
    </form>
  );
}
