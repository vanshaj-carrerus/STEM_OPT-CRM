import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDate } from "@/lib/compliance/dates";
import type { ImmigrationOverview } from "@/lib/immigration/overview";
import { deleteUnemploymentAction, verifyUnemploymentAction } from "./actions";
import { UnemploymentDialog } from "./dialogs";
import { ActionButton } from "./form-dialog";

export function UnemploymentCard({
  candidateId, data, canEdit, canVerify,
}: {
  candidateId: string;
  data: ImmigrationOverview["unemployment"];
  canEdit: boolean;
  canVerify: boolean;
}) {
  const { status, rows } = data;
  const tone = status.level === "ok" ? "success" : status.level === "approaching" ? "warning" : "danger";
  return (
    <Card>
      <CardHeader
        title="Unemployment days"
        description="Manually recorded periods. Overlaps are merged; both end dates count."
        action={canEdit ? <UnemploymentDialog candidateId={candidateId} /> : undefined}
      />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xl font-semibold tabular-nums">{status.totalDays}</span>
          <span className="text-sm text-muted-foreground">of {status.limit} days (commonly cited)</span>
          <Badge tone={tone}>{status.level === "ok" ? "Within range" : status.level === "approaching" ? "Approaching limit" : "At / over limit"}</Badge>
        </div>
        <p className={status.level === "ok" ? "text-xs text-muted-foreground" : "flex items-start gap-1.5 text-xs text-warning"}>
          {status.level !== "ok" && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          {status.label}
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No unemployment periods recorded.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rows.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div>
                  {formatDate(u.startDate)} → {u.endDate ? formatDate(u.endDate) : "ongoing"}
                  {u.notes && <span className="block text-xs text-muted-foreground">{u.notes}</span>}
                </div>
                <div className="flex flex-wrap items-start gap-1">
                  {u.verified ? <Badge tone="success">Verified{u.verifiedByName ? ` by ${u.verifiedByName}` : ""}</Badge> : <Badge tone="warning">Unverified</Badge>}
                  {canVerify && !u.verified && (
                    <ActionButton variant="secondary" action={verifyUnemploymentAction.bind(null, candidateId, u.id)}>Verify</ActionButton>
                  )}
                  {canEdit && (
                    <ActionButton variant="ghost" confirm="Delete this unemployment period?" action={deleteUnemploymentAction.bind(null, candidateId, u.id)}>Delete</ActionButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
