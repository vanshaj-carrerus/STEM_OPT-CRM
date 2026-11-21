"use client";

import { useActionState, useEffect, useRef } from "react";
import { FormAlert, Select, SubmitButton, Textarea } from "@/components/ui/form";
import { addContactAction, addNoteAction, type CandidateFormState } from "../actions";

export function NoteForm({ candidateId }: { candidateId: string }) {
  const [state, action] = useActionState<CandidateFormState, FormData>(addNoteAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.saved) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="space-y-2">
      <input type="hidden" name="id" value={candidateId} />
      <FormAlert error={state.error} />
      <Textarea name="text" placeholder="Add a case note…" required maxLength={4000} />
      <SubmitButton size="sm" variant="secondary" pendingText="Saving…">
        Add note
      </SubmitButton>
    </form>
  );
}

export function ContactForm({ candidateId }: { candidateId: string }) {
  const [state, action] = useActionState<CandidateFormState, FormData>(addContactAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.saved) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="space-y-2">
      <input type="hidden" name="id" value={candidateId} />
      <FormAlert error={state.error} />
      <div className="flex gap-2">
        <Select name="channel" defaultValue="call" className="w-32">
          <option value="call">Call</option>
          <option value="email">Email</option>
          <option value="meeting">Meeting</option>
          <option value="message">Message</option>
          <option value="other">Other</option>
        </Select>
        <Textarea name="summary" placeholder="Summary of contact…" required rows={1} maxLength={2000} className="min-h-9" />
      </div>
      <SubmitButton size="sm" variant="secondary" pendingText="Saving…">
        Log contact
      </SubmitButton>
    </form>
  );
}
