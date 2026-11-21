import { CircleCheck } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { DOCUMENT_TYPE_MAP } from "@/lib/documents/types";
import { formatDate } from "@/lib/compliance/dates";
import type { EvidenceDocInfo } from "@/lib/immigration/evidence";
import type { PeriodView } from "@/lib/immigration/overview";
import { deletePeriodAction, verifyPeriodAction } from "./actions";
import { PeriodDialog, UnverifyDialog } from "./dialogs";
import { ActionButton } from "./form-dialog";

const TYPE_LABEL: Record<PeriodView["type"], string> = { CPT: "CPT", OPT: "OPT", STEM_OPT: "STEM OPT" };
const TYPE_TONE: Record<PeriodView["type"], Tone> = { CPT: "info", OPT: "primary", STEM_OPT: "success" };

export function verificationBadge(p: PeriodView) {
  if (p.effectivelyVerified) return <Badge tone="success">Verified</Badge>;
  if (p.verification === "verified") return <Badge tone="warning">Evidence no longer verified</Badge>;
  if (p.verification === "rejected") return <Badge tone="danger">Rejected</Badge>;
  return <Badge tone="warning">Unverified: no milestones</Badge>;
}

export function PeriodsCard({
  candidateId, periods, employers, evidence, canEdit, canVerify, defaultEducationLevel,
}: {
  candidateId: string;
  periods: PeriodView[];
  employers: { id: string; name: string }[];
  evidence: EvidenceDocInfo[];
  canEdit: boolean;
  canVerify: boolean;
  defaultEducationLevel?: string;
}) {
  return (
    <Card>
      <CardHeader
        title="Authorization timeline"
        description="Each CPT segment is employer-specific with its own approved dates. Milestones are generated only from verified dates."
        action={canEdit ? <PeriodDialog candidateId={candidateId} employers={employers} evidence={evidence} defaultEducationLevel={defaultEducationLevel} /> : undefined}
      />
      {periods.length === 0 ? (
        <EmptyState title="No authorization periods recorded" description="Add the CPT segment, OPT or STEM OPT dates from the official documents." />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <tr>
                <TH>Type</TH>
                <TH>Dates</TH>
                <TH>Employer / details</TH>
                <TH>Evidence</TH>
                <TH>Status</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <tbody>
              {periods.map((p) => (
                <TR key={p.id}>
                  <TD>
                    <Badge tone={TYPE_TONE[p.type]}>{TYPE_LABEL[p.type]}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap">
                    {formatDate(p.startDate)} → {formatDate(p.endDate)}
                  </TD>
                  <TD>
                    <div>{p.employerName ?? <span className="text-muted-foreground">No employer</span>}</div>
                    <div className="text-xs text-muted-foreground">
                      {[p.type === "CPT" ? (p.fullTime ? "Full-time" : "Part-time") : null, p.educationLevel, p.category].filter(Boolean).join(" · ")}
                    </div>
                  </TD>
                  <TD>
                    {p.evidence ? (
                      <div>
                        <div className="text-xs">{DOCUMENT_TYPE_MAP[p.evidence.type]?.label ?? p.evidence.type}</div>
                        <Badge tone={p.evidence.verification === "verified" ? "success" : p.evidence.verification === "rejected" ? "danger" : "warning"}>
                          {p.evidence.verification.replace("_", " ")}
                        </Badge>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{p.evidenceDocumentId ? "Document unavailable" : "None attached"}</span>
                    )}
                  </TD>
                  <TD>
                    <div className="space-y-1">
                      {verificationBadge(p)}
                      {p.effectivelyVerified && p.verifiedByName && <div className="text-xs text-muted-foreground">by {p.verifiedByName}</div>}
                    </div>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-start justify-end gap-1">
                      {canEdit && <PeriodDialog candidateId={candidateId} employers={employers} evidence={evidence} period={p} />}
                      {canVerify && p.verification !== "verified" && p.evidenceDocumentId && (
                        <ActionButton icon={<CircleCheck className="h-3.5 w-3.5" />} variant="secondary" action={verifyPeriodAction.bind(null, candidateId, p.id)}>
                          Verify
                        </ActionButton>
                      )}
                      {canVerify && p.verification === "verified" && <UnverifyDialog candidateId={candidateId} periodId={p.id} />}
                      {canEdit && p.verification !== "verified" && (
                        <ActionButton variant="ghost" confirm="Delete this authorization period?" action={deletePeriodAction.bind(null, candidateId, p.id)}>
                          Delete
                        </ActionButton>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}
