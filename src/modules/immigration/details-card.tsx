import { AlertTriangle } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SensitiveField } from "@/app/(app)/candidates/[id]/sensitive-field";
import { AUTH_TYPE_LABELS } from "@/lib/candidates/constants";
import { formatDate } from "@/lib/compliance/dates";
import { RISK_LABELS } from "@/lib/immigration/flags-rules";
import type { CandidateView } from "@/lib/candidates/service";

function Item({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

/** Candidate-level immigration fields (informational: verified authorization periods drive milestones). SEVIS/EAD masked. */
export function DetailsCard({
  candidateId, c, canSevis, canEad, riskFlags, cpt,
}: {
  candidateId: string;
  c: Partial<CandidateView>;
  canSevis: boolean;
  canEad: boolean;
  riskFlags: string[];
  cpt: { flag: boolean; days: number; message?: string };
}) {
  const flags = riskFlags.filter((f) => RISK_LABELS[f]);
  return (
    <>
      {(cpt.flag || flags.length > 0) && (
        <Card>
          <CardHeader title="Flags for review" description="Operational flags, not legal conclusions." />
          <CardBody>
            <ul className="space-y-2 text-xs">
              {cpt.flag && (
                <li className="flex items-start gap-1.5 text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {cpt.message} ({cpt.days} full-time CPT days recorded)
                  </span>
                </li>
              )}
              {flags
                .filter((f) => !(cpt.flag && f.includes("cpt_full_time")))
                .map((f) => (
                  <li key={f} className="flex items-start gap-1.5 text-warning">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{RISK_LABELS[f]}</span>
                  </li>
                ))}
            </ul>
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader title="Immigration details" description="Candidate-level record. Verified authorization periods above drive milestones and clearance." />
        <CardBody>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Item label="Authorization type">{c.authType && c.authType !== "none" ? <Badge tone="info">{AUTH_TYPE_LABELS[c.authType]}</Badge> : null}</Item>
            <Item label="Visa status">{c.visaStatus}</Item>
            <Item label="EAD category">{c.eadCategory}</Item>
            <Item label="EAD dates (candidate record)">{c.eadStart || c.eadEnd ? `${formatDate(c.eadStart)} → ${formatDate(c.eadEnd)}` : ""}</Item>
            <Item label="I-20 issued / endorsed">
              {c.i20IssueDate || c.i20EndorsementDate ? `${formatDate(c.i20IssueDate)} / ${formatDate(c.i20EndorsementDate)}` : ""}
            </Item>
            <Item label="I-983 status">{c.i983Status?.replace(/_/g, " ")}</Item>
            <Item label="Receipt number">{c.receiptNumber}</Item>
            <Item label="Case status">{c.caseStatus}</Item>
            {canSevis && (
              <Item label="SEVIS ID">
                <SensitiveField candidateId={candidateId} field="sevisId" mask={c.sevisId} />
              </Item>
            )}
            {canEad && (
              <Item label="EAD number">
                <SensitiveField candidateId={candidateId} field="eadNumber" mask={c.eadNumber} />
              </Item>
            )}
            <Item label="DSO contact">{[c.dsoName, c.dsoEmail, c.dsoPhone].filter(Boolean).join(" · ")}</Item>
            <Item label="School">{[c.school, c.campus].filter(Boolean).join(" · ")}</Item>
          </dl>
        </CardBody>
      </Card>
    </>
  );
}
