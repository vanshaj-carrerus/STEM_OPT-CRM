import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDate } from "@/lib/compliance/dates";
import type { ImmigrationOverview } from "@/lib/immigration/overview";
import { clearToWorkAction, recheckAction } from "./actions";
import { RevokeDialog } from "./dialogs";
import { ActionButton } from "./form-dialog";

export function ClearanceCard({
  candidateId, clearance, canEdit, canVerify,
}: {
  candidateId: string;
  clearance: ImmigrationOverview["clearance"];
  canEdit: boolean;
  canVerify: boolean;
}) {
  const blockers = clearance.reasons;
  const stale = clearance.cleared && blockers.length > 0;
  return (
    <Card>
      <CardHeader
        title="Clearance to work"
        description="Set only from verified evidence by an authorized reviewer. Payroll status is never an input."
        action={
          clearance.cleared ? (
            <Badge tone={stale ? "warning" : "success"}>
              <ShieldCheck className="h-3 w-3" /> {stale ? "Cleared: needs re-check" : "Cleared"}
            </Badge>
          ) : (
            <Badge tone="warning">
              <ShieldAlert className="h-3 w-3" /> Not cleared
            </Badge>
          )
        }
      />
      <CardBody className="space-y-4">
        {clearance.cleared && (
          <p className="text-xs text-muted-foreground">
            Cleared by {clearance.clearedByName ?? "reviewer"} {clearance.clearedAt && `on ${formatDate(clearance.clearedAt.slice(0, 10))}`}.
          </p>
        )}
        {clearance.plannedWorkStart && <p className="text-xs text-muted-foreground">Evaluated against work start {formatDate(clearance.plannedWorkStart)}.</p>}

        {stale && (
          <p role="alert" className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs text-warning">
            The conditions that justified this clearance no longer hold. It will be revoked automatically on the next re-check (audit-logged).
          </p>
        )}
        {blockers.length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs font-semibold">Blockers</p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-danger">
              {blockers.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : (
          !clearance.cleared && <p className="text-xs text-success">All clearance conditions are met. A reviewer can clear this candidate to work.</p>
        )}
        {clearance.warnings.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-xs text-warning">
            {clearance.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-start gap-2">
          {canVerify && !clearance.cleared && blockers.length === 0 && (
            <ActionButton variant="primary" size="md" confirm="Confirm that the evidence has been reviewed and this candidate may start work?" action={clearToWorkAction.bind(null, candidateId)}>
              Clear to work
            </ActionButton>
          )}
          {canVerify && clearance.cleared && <RevokeDialog candidateId={candidateId} />}
          {canEdit && (
            <ActionButton action={recheckAction.bind(null, candidateId)}>Re-check &amp; regenerate milestones</ActionButton>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          This CRM is an operational tracker, not a legal eligibility engine. Authorization decisions rest with the official documents, the DSO and counsel.
        </p>
      </CardBody>
    </Card>
  );
}
