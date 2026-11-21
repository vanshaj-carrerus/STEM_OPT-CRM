import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Pencil, ShieldCheck, ShieldAlert } from "lucide-react";
import { loadCandidateFor, requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import type { Permission } from "@/lib/rbac/permissions";
import { toCandidateView } from "@/lib/candidates/service";
import { userNameMap } from "@/lib/users/directory";
import { AUTH_TYPE_LABELS, STAGE_LABELS } from "@/lib/db/models/candidate";
import { audit } from "@/lib/audit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OverviewTab, type OverviewExtras } from "./overview-tab";
import { connectDb } from "@/lib/db/connect";
import { Employer, EmploymentRecord, type IEmployer, type IEmploymentRecord } from "@/lib/db/models/employer";
import { getMissingDocuments } from "@/lib/documents/service";
import { REQUIRED_DOCS } from "@/lib/documents/types";
import { ActivityTab } from "./activity-tab";
import { CandidateImmigrationTab } from "@/modules/immigration/candidate-tab";
import { CandidateDocumentsTab } from "@/modules/documents/candidate-tab";
import { CandidateEmploymentTab } from "@/modules/employment/candidate-tab";
import { CandidateTrackerTab } from "@/modules/tracker/candidate-tab";
import { CandidatePayrollTab } from "@/modules/payroll/candidate-tab";
import { CandidatePaymentsTab } from "@/modules/payments/candidate-tab";
import { CandidateTasksTab } from "@/modules/tasks/candidate-tab";

export const metadata: Metadata = { title: "Candidate" };

const TABS: { key: string; label: string; perm: Permission }[] = [
  { key: "overview", label: "Overview", perm: "candidates.view" },
  { key: "immigration", label: "Immigration", perm: "immigration.view" },
  { key: "documents", label: "Documents", perm: "documents.view" },
  { key: "employment", label: "Employment", perm: "candidates.view" },
  { key: "tracker", label: "12-Month Tracker", perm: "tracker.view" },
  { key: "payroll", label: "Payroll", perm: "payroll.view" },
  { key: "payments", label: "Payments", perm: "payments.view" },
  { key: "tasks", label: "Tasks", perm: "tasks.view" },
  { key: "activity", label: "Activity / Audit", perm: "audit.view" },
];

export default async function CandidateDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  const user = await requirePage("candidates.view");
  const candidate = await loadCandidateFor(user, id);
  if (!candidate) notFound();

  const visible = TABS.filter((t) => can(user, t.perm));
  const tab = visible.find((t) => t.key === tabParam)?.key ?? "overview";
  const c = toCandidateView(user, candidate);
  const names = await userNameMap([candidate.ownerId, candidate.recruiterId]);

  // read-only summaries drawn from the related modules (nothing is duplicated onto the candidate record)
  const extras: OverviewExtras = {};
  if (tab === "overview") {
    await connectDb();
    const rec = await EmploymentRecord.findOne({ candidateId: id, status: "active" }).sort({ startDate: -1 }).lean<IEmploymentRecord>();
    const employerId = rec?.employerId ?? candidate.currentEmployerId ?? null;
    const employer = employerId ? await Employer.findById(employerId).select("legalName").lean<IEmployer>() : null;
    extras.employment =
      rec || employer
        ? {
            employer: employer?.legalName,
            jobTitle: rec?.jobTitle,
            worksite: rec?.worksiteName,
            hoursPerWeek: rec?.hoursPerWeek,
            startDate: rec?.startDate,
            endDate: rec?.endDate ?? null,
            relatedToDegree: rec?.relatedToDegree,
          }
        : null;
    if (can(user, "documents.view")) {
      const missing = await getMissingDocuments(id);
      extras.checklist = { required: REQUIRED_DOCS[candidate.authType].length, missing: missing.map((m) => ({ label: m.label, reason: m.reason })) };
    }
  }

  if (tab === "overview") {
    await audit({ actor: user, action: "read", entityType: "candidate", entityId: id, candidateId: id, summary: "Viewed candidate profile" });
  }

  const auth = candidate.authType !== "none" ? AUTH_TYPE_LABELS[candidate.authType] : null;
  const canSeeImmigration = can(user, "immigration.view");

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">
            <Link href="/candidates" className="hover:underline">
              Candidates
            </Link>{" "}
            / {candidate.candidateCode}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{candidate.legalName}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="primary">{STAGE_LABELS[candidate.stage]}</Badge>
            {canSeeImmigration && auth && <Badge tone="info">{auth}</Badge>}
            {canSeeImmigration &&
              (candidate.clearedToWork ? (
                <Badge tone="success">
                  <ShieldCheck className="h-3 w-3" /> Cleared (evidence verified)
                </Badge>
              ) : (
                <Badge tone="warning">
                  <ShieldAlert className="h-3 w-3" /> Not cleared to work
                </Badge>
              ))}
            {canSeeImmigration && candidate.riskFlags.length > 0 && (
              <Badge tone="danger">
                <AlertTriangle className="h-3 w-3" /> {candidate.riskFlags.length} risk flag{candidate.riskFlags.length > 1 ? "s" : ""}
              </Badge>
            )}
            {candidate.priority !== "normal" && <Badge tone={candidate.priority === "low" ? "neutral" : "warning"}>{candidate.priority} priority</Badge>}
          </div>
        </div>
        {can(user, "candidates.edit") && (
          <Button asChild variant="outline">
            <Link href={`/candidates/${id}/edit`}>
              <Pencil className="h-4 w-4" /> Edit
            </Link>
          </Button>
        )}
      </div>

      <nav className="mb-5 flex gap-1 overflow-x-auto border-b" aria-label="Candidate sections">
        {visible.map((t) => (
          <Link
            key={t.key}
            href={`/candidates/${id}?tab=${t.key}`}
            aria-current={t.key === tab ? "page" : undefined}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium",
              t.key === tab ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "overview" && <OverviewTab user={user} c={c} extras={extras} ownerName={candidate.ownerId ? names[candidate.ownerId] : undefined} recruiterName={candidate.recruiterId ? names[candidate.recruiterId] : undefined} />}
      {tab === "immigration" && <CandidateImmigrationTab candidateId={id} />}
      {tab === "documents" && <CandidateDocumentsTab candidateId={id} />}
      {tab === "employment" && <CandidateEmploymentTab candidateId={id} />}
      {tab === "tracker" && <CandidateTrackerTab candidateId={id} />}
      {tab === "payroll" && <CandidatePayrollTab candidateId={id} />}
      {tab === "payments" && <CandidatePaymentsTab candidateId={id} />}
      {tab === "tasks" && <CandidateTasksTab candidateId={id} />}
      {tab === "activity" && <ActivityTab candidateId={id} />}
    </>
  );
}
