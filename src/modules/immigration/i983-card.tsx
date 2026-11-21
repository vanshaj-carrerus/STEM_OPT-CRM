import { CircleCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDate } from "@/lib/compliance/dates";
import type { EvidenceDocInfo } from "@/lib/immigration/evidence";
import type { PeriodView } from "@/lib/immigration/overview";
import { verifyI983Action } from "./actions";
import { I983Dialog } from "./dialogs";
import { ActionButton } from "./form-dialog";

const STATUS_LABEL: Record<string, string> = {
  not_started: "Not started", draft: "Draft", awaiting_signatures: "Awaiting signatures", signed: "Signed",
  submitted_to_dso: "Submitted to DSO", needs_update: "Needs update", not_applicable: "Not applicable",
};

/** STEM OPT: Form I-983 version / signatures per STEM period. Hidden when the candidate has no STEM OPT period. */
export function I983Card({
  candidateId, periods, evidence, canEdit, canVerify,
}: {
  candidateId: string;
  periods: PeriodView[];
  evidence: EvidenceDocInfo[];
  canEdit: boolean;
  canVerify: boolean;
}) {
  const stem = periods.filter((p) => p.type === "STEM_OPT" && p.verification !== "rejected");
  if (!stem.length) return null;
  return (
    <Card>
      <CardHeader
        title="Form I-983 (STEM OPT training plan)"
        description="Records version and signatures. Clearance for STEM OPT needs a verified I-983, E-Verify details on the employer and at least 20 hours per week."
      />
      <CardBody className="space-y-4">
        {stem.map((p) => {
          const r = p.i983;
          return (
            <div key={p.id} className="rounded-md border p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  STEM OPT {formatDate(p.startDate)} → {formatDate(p.endDate)}
                  {p.employerName && <span className="text-muted-foreground"> · {p.employerName}</span>}
                </p>
                {r ? (
                  <Badge tone={r.verification === "verified" ? "success" : "warning"}>{r.verification === "verified" ? "I-983 verified" : "I-983 unverified"}</Badge>
                ) : (
                  <Badge tone="warning">Not recorded</Badge>
                )}
              </div>
              {r && (
                <dl className="mb-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div><dt className="text-muted-foreground">Status</dt><dd>{STATUS_LABEL[r.status] ?? r.status}</dd></div>
                  <div><dt className="text-muted-foreground">Form version</dt><dd>{r.formVersion || "—"}</dd></div>
                  <div><dt className="text-muted-foreground">Student signed</dt><dd>{r.studentSignedOn ? formatDate(r.studentSignedOn) : "—"}</dd></div>
                  <div><dt className="text-muted-foreground">Employer signed</dt><dd>{r.employerSignedOn ? formatDate(r.employerSignedOn) : "—"}</dd></div>
                  <div><dt className="text-muted-foreground">Submitted to DSO</dt><dd>{r.dsoSubmittedOn ? formatDate(r.dsoSubmittedOn) : "—"}</dd></div>
                  {r.verifiedByName && <div><dt className="text-muted-foreground">Verified by</dt><dd>{r.verifiedByName}</dd></div>}
                  {r.trainingPlanSummary && <div className="sm:col-span-2"><dt className="text-muted-foreground">Training plan</dt><dd className="whitespace-pre-wrap">{r.trainingPlanSummary}</dd></div>}
                </dl>
              )}
              <div className="flex flex-wrap items-start gap-2">
                {canEdit && <I983Dialog candidateId={candidateId} period={p} evidence={evidence} />}
                {canVerify && r && r.verification !== "verified" && (
                  <ActionButton icon={<CircleCheck className="h-3.5 w-3.5" />} variant="secondary" action={verifyI983Action.bind(null, candidateId, p.id)}>
                    Verify I-983
                  </ActionButton>
                )}
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
