"use client";

import { useActionState } from "react";
import { FormAlert, SubmitButton, Textarea } from "@/components/ui/form";
import { reviewDocumentAction, type ReviewState } from "./actions";

/** Verify / reject the latest version. Rejecting needs a note (enforced server-side too). */
export function ReviewControls({ documentId }: { documentId: string }) {
  const [state, action] = useActionState<ReviewState, FormData>(reviewDocumentAction, {});
  return (
    <form action={action} className="mt-3 space-y-2 rounded-md border bg-muted/40 p-3">
      <input type="hidden" name="documentId" value={documentId} />
      <FormAlert error={state.error} message={state.saved ? "Review recorded." : undefined} />
      <Textarea name="note" rows={2} maxLength={1000} placeholder="Reviewer note (required when rejecting)" aria-label="Reviewer note" />
      <div className="flex flex-wrap gap-2">
        <SubmitButton size="sm" name="decision" value="verified" pendingText="Saving…">
          Verify
        </SubmitButton>
        <SubmitButton size="sm" variant="danger" name="decision" value="rejected" pendingText="Saving…">
          Reject
        </SubmitButton>
      </div>
    </form>
  );
}
