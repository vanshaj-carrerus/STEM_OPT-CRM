import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCandidateFor, requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/table";
import { formatDate } from "@/lib/compliance/dates";
import { todayFor } from "@/lib/immigration/calendar";
import { canSeePayTerms, listEmployment } from "@/lib/employment/service";
import { ActionButton } from "../immigration/form-dialog";
import type { CandidateTabProps } from "../tab-types";
import { setCurrentEmployerAction } from "./actions";
import { EmploymentDialog, EndEmploymentDialog } from "./dialogs";

const RELATION: Record<string, { label: string; tone: "success" | "danger" | "warning" }> = {
  yes: { label: "Related to degree", tone: "success" },
  no: { label: "Not related", tone: "danger" },
  needs_review: { label: "Relation needs review", tone: "warning" },
};

/** Employment tab: employment records per employer with relation-to-degree review. Pay terms are restricted. */
export async function CandidateEmploymentTab({ candidateId }: CandidateTabProps) {
  const user = await requirePage("candidates.view");
  const candidate = await loadCandidateFor(user, candidateId);
  if (!candidate) notFound();

  const { rows, employers, currentEmployerId } = await listEmployment(user, candidateId);
  const canEdit = can(user, "candidates.edit");
  const canPay = canSeePayTerms(user);
  const today = todayFor(user);

  return (
    <Card>
      <CardHeader
        title="Employment records"
        description="Operational employment history. Adding or ending employment never grants clearance to work; only verified authorization evidence does."
        action={
          canEdit ? <EmploymentDialog candidateId={candidateId} employers={employers} canPay={canPay} hasCurrent={!!currentEmployerId} /> : undefined
        }
      />
      <CardBody className="space-y-4">
        {rows.length === 0 ? (
          <EmptyState
            title="No employment recorded"
            description={employers.length === 0 ? "Add the employer first, then record the employment." : "Add the employment record for this candidate."}
            action={
              can(user, "immigration.edit") && employers.length === 0 ? (
                <Button asChild size="sm" variant="outline">
                  <Link href="/employers/new">Add employer</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          rows.map((r) => (
            <div key={r.id} className="rounded-md border p-4">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">
                    {r.employerName ? (
                      <Link href={`/employers/${r.employerId}`} className="hover:underline">
                        {r.employerName}
                      </Link>
                    ) : (
                      "Unknown employer"
                    )}
                    {r.jobTitle && <span className="font-normal text-muted-foreground"> · {r.jobTitle}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.startDate ? formatDate(r.startDate) : "Start date not set"} → {r.endDate ? formatDate(r.endDate) : "present"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={r.status === "active" ? "success" : "neutral"}>{r.status}</Badge>
                  {r.isCurrent && <Badge tone="primary">Current employer</Badge>}
                  {r.relatedToDegree && <Badge tone={RELATION[r.relatedToDegree].tone}>{RELATION[r.relatedToDegree].label}</Badge>}
                </div>
              </div>
              <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                <div><dt className="text-muted-foreground">Hours per week</dt><dd>{r.hoursPerWeek ?? "—"}</dd></div>
                <div><dt className="text-muted-foreground">Supervisor</dt><dd>{[r.supervisor?.name, r.supervisor?.email, r.supervisor?.phone].filter(Boolean).join(" · ") || "—"}</dd></div>
                <div><dt className="text-muted-foreground">Worksite</dt><dd>{[r.worksiteName, r.worksiteAddress].filter(Boolean).join(" · ") || "—"}</dd></div>
                {canPay && <div><dt className="text-muted-foreground">Pay terms (restricted)</dt><dd>{r.payTerms || "—"}</dd></div>}
                {r.jobDuties && <div className="sm:col-span-2 lg:col-span-3"><dt className="text-muted-foreground">Job duties</dt><dd className="whitespace-pre-wrap">{r.jobDuties}</dd></div>}
                {r.relationReviewNote && <div className="sm:col-span-2 lg:col-span-3"><dt className="text-muted-foreground">Relation-to-degree note</dt><dd className="whitespace-pre-wrap">{r.relationReviewNote}</dd></div>}
              </dl>
              {canEdit && (
                <div className="mt-3 flex flex-wrap items-start gap-1">
                  <EmploymentDialog candidateId={candidateId} employers={employers} record={r} canPay={canPay} hasCurrent={!!currentEmployerId} />
                  {r.status === "active" && !r.isCurrent && (
                    <ActionButton variant="secondary" action={setCurrentEmployerAction.bind(null, candidateId, r.employerId)}>
                      Set as current employer
                    </ActionButton>
                  )}
                  {r.status === "active" && <EndEmploymentDialog candidateId={candidateId} recordId={r.id} today={today} />}
                </div>
              )}
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}
