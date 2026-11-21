import { can } from "@/lib/rbac/can";
import type { SessionUser } from "@/lib/auth/session";
import type { CandidateView } from "@/lib/candidates/service";
import { formatDate } from "@/lib/compliance/dates";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SensitiveField } from "./sensitive-field";
import { ContactForm, NoteForm } from "./notes-forms";

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

export interface OverviewExtras {
  /** current employer + active employment record (read-only summary; full detail lives in the Employment tab) */
  employment?: { employer?: string; jobTitle?: string; worksite?: string; hoursPerWeek?: number; startDate?: string; endDate?: string | null; relatedToDegree?: string } | null;
  /** required-document checklist state (read-only; managed in the Documents tab) */
  checklist?: { required: number; missing: { label: string; reason: string }[] } | null;
}

const REASON_LABELS: Record<string, string> = { not_uploaded: "not uploaded", pending_review: "awaiting review", rejected: "rejected", expired: "expired" };

export function OverviewTab({
  user,
  c,
  ownerName,
  recruiterName,
  extras = {},
}: {
  user: SessionUser;
  c: Partial<CandidateView>;
  ownerName?: string;
  recruiterName?: string;
  extras?: OverviewExtras;
}) {
  const id = c._id as string;
  const addr = c.address;
  const address = [addr?.line1, addr?.line2, [addr?.city, addr?.state, addr?.postalCode].filter(Boolean).join(", "), addr?.country].filter(Boolean).join(" · ");
  const dateTime = (d?: Date | string) => (d ? new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader title="Identity & contact" />
          <CardBody>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Item label="Legal name">{c.legalName}</Item>
              <Item label="Preferred name">{c.preferredName}</Item>
              <Item label="Email">{c.email}</Item>
              <Item label="Phone">{c.phone}</Item>
              {can(user, "sensitive.dob.view") && (
                <Item label="Date of birth">
                  <SensitiveField candidateId={id} field="dateOfBirth" mask={c.dateOfBirth} />
                </Item>
              )}
              <Item label="Country of citizenship">{c.country}</Item>
              <Item label="Address">{address}</Item>
              {c.emergencyContact?.name && (
                <Item label="Emergency contact">
                  {c.emergencyContact.name} {c.emergencyContact.phone && `· ${c.emergencyContact.phone}`}
                </Item>
              )}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Education" />
          <CardBody>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Item label="School / campus">{[c.school, c.campus].filter(Boolean).join(" · ")}</Item>
              <Item label="Degree / major">{[c.degreeLevel, c.degree, c.major].filter(Boolean).join(" · ")}</Item>
              <Item label="STEM CIP code">{c.stemCipCode}</Item>
              <Item label="Program">
                {c.programStart || c.programEnd ? `${formatDate(c.programStart)} → ${formatDate(c.programEnd)}` : ""}
              </Item>
              <Item label="Graduation date">{c.graduationDate ? formatDate(c.graduationDate) : ""}</Item>
              {can(user, "immigration.view") && (
                <Item label="DSO contact">{[c.dsoName, c.dsoEmail, c.dsoPhone].filter(Boolean).join(" · ")}</Item>
              )}
            </dl>
          </CardBody>
        </Card>

        {can(user, "immigration.view") && (
          <Card>
            <CardHeader title="Immigration summary" description="Read-only. Authorization periods and verified evidence are managed in the Immigration tab." />
            <CardBody>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Item label="Authorization type">{c.authType && c.authType !== "none" ? c.authType.replace("_", " ") : ""}</Item>
                <Item label="Visa / status">{c.visaStatus}</Item>
                <Item label="EAD category">{c.eadCategory}</Item>
                <Item label="EAD validity">{c.eadStart || c.eadEnd ? `${formatDate(c.eadStart)} → ${formatDate(c.eadEnd)}` : ""}</Item>
                <Item label="I-20 issued / endorsed">
                  {c.i20IssueDate || c.i20EndorsementDate ? `${formatDate(c.i20IssueDate)} / ${formatDate(c.i20EndorsementDate)}` : ""}
                </Item>
                <Item label="I-983 status">{c.i983Status && c.i983Status !== "not_applicable" ? c.i983Status.replaceAll("_", " ") : ""}</Item>
                {can(user, "sensitive.sevis.view") && (
                  <Item label="SEVIS ID">
                    <SensitiveField candidateId={id} field="sevisId" mask={c.sevisId} />
                  </Item>
                )}
                {can(user, "sensitive.ead.view") && (
                  <Item label="EAD number">
                    <SensitiveField candidateId={id} field="eadNumber" mask={c.eadNumber} />
                  </Item>
                )}
                <Item label="Receipt number">{c.receiptNumber}</Item>
                <Item label="Case status">{c.caseStatus}</Item>
              </dl>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Employment" description="Read-only summary of the active employment record. Edit it in the Employment tab." />
          <CardBody>
            {extras.employment ? (
              <dl className="grid gap-4 sm:grid-cols-2">
                <Item label="Employer / client">{extras.employment.employer}</Item>
                <Item label="Job title">{extras.employment.jobTitle}</Item>
                <Item label="Worksite">{extras.employment.worksite}</Item>
                <Item label="Hours per week">{extras.employment.hoursPerWeek != null ? String(extras.employment.hoursPerWeek) : ""}</Item>
                <Item label="Employment dates">
                  {extras.employment.startDate ? `${formatDate(extras.employment.startDate)} → ${extras.employment.endDate ? formatDate(extras.employment.endDate) : "present"}` : ""}
                </Item>
                <Item label="Related to degree">{extras.employment.relatedToDegree?.replaceAll("_", " ")}</Item>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No employment record yet.</p>
            )}
          </CardBody>
        </Card>

        {can(user, "immigration.view") && (
        <Card>
          <CardHeader title="Case notes" description="Newest first. Notes are attributed and audit-logged." />
          <CardBody className="space-y-4">
            {can(user, "candidates.edit") && <NoteForm candidateId={id} />}
            <ul className="space-y-3">
              {(c.notes ?? []).map((n) => (
                <li key={n._id} className="rounded-md border bg-muted/40 p-3 text-sm">
                  <p className="whitespace-pre-wrap">{n.text}</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {n.authorName ?? "Unknown"} · {dateTime(n.createdAt)}
                  </p>
                </li>
              ))}
              {(c.notes ?? []).length === 0 && <li className="text-sm text-muted-foreground">No notes yet.</li>}
            </ul>
          </CardBody>
        </Card>
        )}
      </div>

      <div className="space-y-5">
        <Card>
          <CardHeader title="Operations" />
          <CardBody>
            <dl className="space-y-4">
              <Item label="Compliance owner">{ownerName}</Item>
              <Item label="Recruiter">{recruiterName}</Item>
              <Item label="Next due">{c.nextDueDate ? formatDate(c.nextDueDate) : ""}</Item>
              <Item label="Source">{c.source}</Item>
              {can(user, "payroll.view") && (
                <Item label="Payroll mapping">
                  {c.payrollMapping?.employeeId ? (
                    <span>
                      Gusto employee mapped <span className="text-muted-foreground">({c.payrollMapping.paySchedule ?? "schedule not set"})</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not mapped to a payroll employee</span>
                  )}
                </Item>
              )}
              {extras.checklist && (
                <Item label="Document checklist">
                  {extras.checklist.missing.length === 0 ? (
                    <span className="text-success">All {extras.checklist.required} required documents verified</span>
                  ) : (
                    <span>
                      {extras.checklist.required - extras.checklist.missing.length} of {extras.checklist.required} verified
                      <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                        {extras.checklist.missing.map((m) => (
                          <li key={m.label}>
                            {m.label} — {REASON_LABELS[m.reason] ?? m.reason}
                          </li>
                        ))}
                      </ul>
                    </span>
                  )}
                </Item>
              )}
              <Item label="Tags">
                {(c.tags ?? []).length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {c.tags!.map((t) => (
                      <Badge key={t} tone="neutral">
                        {t}
                      </Badge>
                    ))}
                  </span>
                )}
              </Item>
            </dl>
          </CardBody>
        </Card>

        {can(user, "immigration.view") && (
        <Card>
          <CardHeader title="Contact history" />
          <CardBody className="space-y-4">
            {can(user, "candidates.edit") && <ContactForm candidateId={id} />}
            <ul className="space-y-3">
              {(c.contactHistory ?? []).slice(0, 25).map((h) => (
                <li key={h._id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <Badge tone="info">{h.channel}</Badge>
                    <span className="text-xs text-muted-foreground">{dateTime(h.at)}</span>
                  </div>
                  <p className="mt-1">{h.summary}</p>
                  <p className="text-xs text-muted-foreground">{h.byName}</p>
                </li>
              ))}
              {(c.contactHistory ?? []).length === 0 && <li className="text-sm text-muted-foreground">No contact logged yet.</li>}
            </ul>
          </CardBody>
        </Card>
        )}
      </div>
    </div>
  );
}
