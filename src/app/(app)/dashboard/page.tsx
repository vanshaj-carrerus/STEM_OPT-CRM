import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { ROLE_LABELS } from "@/lib/rbac/permissions";
import { todayIn } from "@/lib/compliance/dates";
import { candidateKpis } from "@/lib/dashboard/candidates";
import { candidatesAtRisk, taskWidgetCounts } from "@/lib/tasks/queries";
import { documentStats } from "@/lib/documents/service";
import { payrollDashboard } from "@/lib/payroll/queries";
import { paymentsDashboard } from "@/lib/payments/queries";
import { PAYROLL_STATUS_LABELS, PAYROLL_STATUSES } from "@/lib/payroll/rules";
import { listAssignableUsers } from "@/lib/users/directory";
import { AUTH_TYPE_LABELS } from "@/lib/candidates/constants";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };

type SP = { ownerId?: string; authType?: string };
type Tone = "neutral" | "danger" | "warning" | "success" | "info";

const toneText: Record<Tone, string> = {
  neutral: "text-foreground",
  danger: "text-danger",
  warning: "text-warning",
  success: "text-success",
  info: "text-info",
};

function Stat({ label, value, href, tone = "neutral", hint }: { label: string; value: number | string; href?: string; tone?: Tone; hint?: string }) {
  const body = (
    <div className="h-full rounded-lg border bg-card p-4 shadow-sm transition-colors hover:bg-muted/40">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", toneText[Number(value) > 0 || typeof value === "string" ? tone : "neutral"])}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function Section({ title, description, href, children }: { title: string; description?: string; href?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        action={
          href && (
            <Link href={href} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Open <ArrowRight className="h-3 w-3" />
            </Link>
          )
        }
      />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePage("dashboard.view");
  const sp = await searchParams;
  const today = todayIn(user.timezone);
  const filters = { ownerId: sp.ownerId || undefined, authType: can(user, "immigration.view") ? sp.authType || undefined : undefined };

  const canTasks = can(user, "tasks.view");
  const canDocs = can(user, "documents.view");
  const canPayroll = can(user, "payroll.view") || can(user, "emergency.view");
  const canPayments = can(user, "payments.view");
  const canImm = can(user, "immigration.view");

  const [owners, kpi, widgets, risk, docs, payroll, payments] = await Promise.all([
    can(user, "candidates.viewAll") ? listAssignableUsers() : Promise.resolve([]),
    can(user, "candidates.view") ? candidateKpis(user, today, filters) : null,
    canTasks ? taskWidgetCounts(user, filters, today) : null,
    canTasks ? candidatesAtRisk(user, today) : null,
    canDocs ? documentStats(user) : null,
    canPayroll ? payrollDashboard(user) : null,
    canPayments ? paymentsDashboard(user) : null,
  ]);

  const q = new URLSearchParams();
  if (filters.ownerId) q.set("ownerId", filters.ownerId);
  if (filters.authType) q.set("authType", filters.authType);
  const cal = (extra: string) => `/calendar?view=list${extra}${q.size ? `&${q}` : ""}`;
  const attention =
    (widgets?.overdue ?? 0) + (docs?.expired ?? 0) + (docs?.rejected ?? 0) + (payments?.failed ?? 0) + (payroll?.emergencyActionRequired ?? 0) + (payroll?.reconciliationDifferences ?? 0);

  return (
    <>
      <PageHeader title={`Welcome, ${user.name.split(" ")[0]}`} description={`${ROLE_LABELS[user.role]} · today is ${today}. Counts are limited to the records you can access.`} />

      {(owners.length > 0 || canImm) && (
        <form method="get" className="mb-5 flex flex-wrap items-end gap-3">
          {owners.length > 0 && (
            <Select name="ownerId" defaultValue={sp.ownerId ?? ""} className="w-48" aria-label="Owner">
              <option value="">All owners</option>
              <option value="unassigned">Unassigned</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
          {canImm && (
            <Select name="authType" defaultValue={sp.authType ?? ""} className="w-44" aria-label="Authorization type">
              <option value="">All authorizations</option>
              {Object.entries(AUTH_TYPE_LABELS)
                .filter(([k]) => k !== "none")
                .map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
            </Select>
          )}
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          <Button asChild variant="ghost">
            <Link href="/dashboard">Reset</Link>
          </Button>
          <p className="text-xs text-muted-foreground">Owner and authorization filters apply to the candidate and task tiles.</p>
        </form>
      )}

      {attention > 0 && (
        <div className="mb-5 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {attention} item{attention === 1 ? "" : "s"} need attention across overdue tasks, documents, payroll and payments.
        </div>
      )}

      <div className="space-y-5">
        {kpi && (
          <Section title="Candidates" href="/candidates" description="CPT / OPT / STEM OPT status and authorizations nearing their end date.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Total candidates" value={kpi.total} href="/candidates" />
              <Stat label="Active pipeline" value={kpi.active} href="/candidates?stage=active" tone="info" />
              {canImm && (
                <>
                  <Stat label="Active CPT" value={kpi.byAuth.CPT} href="/candidates?authType=CPT" />
                  <Stat label="Active OPT" value={kpi.byAuth.OPT} href="/candidates?authType=OPT" />
                  <Stat label="Active STEM OPT" value={kpi.byAuth.STEM_OPT} href="/candidates?authType=STEM_OPT" />
                  <Stat label="Expiring ≤ 30 days" value={kpi.expiring30} href="/reports?report=expiring" tone="danger" />
                  <Stat label="Expiring 31–90 days" value={Math.max(0, kpi.expiring90 - kpi.expiring30)} href="/reports?report=expiring" tone="warning" hint={`${kpi.expiring60 - kpi.expiring30} in 31–60 days`} />
                  <Stat label="Expired — review" value={kpi.expired} href="/reports?report=expiring" tone="danger" />
                </>
              )}
            </div>
          </Section>
        )}

        {widgets && (
          <Section title="Tasks & reminders" href="/calendar" description="Internal due dates. Official DSO windows must be confirmed with the DSO.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Due today" value={widgets.dueToday} href={cal("&due=today")} tone="warning" />
              <Stat label="Due in 7 days" value={widgets.due7Days} href={cal("&due=7d")} />
              <Stat label="Overdue" value={widgets.overdue} href={cal("&due=overdue")} tone="danger" />
              <Stat label="Candidates at risk" value={risk?.count ?? 0} href="/candidates?risk=1" tone="danger" hint="with overdue work" />
              <Stat label="Awaiting candidate" value={widgets.awaitingCandidate} href={cal("&due=awaiting_candidate")} />
              <Stat label="Awaiting employer" value={widgets.awaitingEmployer} href={cal("&due=awaiting_employer")} />
              <Stat label="Awaiting DSO" value={widgets.awaitingDso} href={cal("&due=awaiting_dso")} />
              {docs && <Stat label="Missing documents" value={docs.missing} href="/documents?filter=missing" tone="warning" />}
            </div>
          </Section>
        )}

        {docs && (
          <Section title="Documents" href="/documents" description="Latest versions only.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Awaiting review" value={docs.awaitingReview} href="/documents?filter=awaiting" tone="info" />
              <Stat label="Expiring ≤ 30 days" value={docs.expiring30} href="/documents?filter=expiring" tone="warning" />
              <Stat label="Expired" value={docs.expired} href="/documents?filter=expired" tone="danger" />
              <Stat label="Rejected" value={docs.rejected} href="/documents?filter=rejected" tone="danger" />
            </div>
          </Section>
        )}

        {payroll && (
          <Section title="Payroll & emergency payroll" href="/payroll" description="Gusto is the system of record. Payroll status never indicates work authorization.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Active emergency payroll" value={payroll.activeEmergency} href="/emergency-payroll" tone="warning" />
              <Stat label="Emergency — action required" value={payroll.emergencyActionRequired} href="/emergency-payroll" tone="danger" />
              <Stat label="Processed, not reconciled" value={payroll.unreconciledProcessed} href="/payroll" tone="warning" />
              <Stat label="Reconciliation differences" value={payroll.reconciliationDifferences} href="/payroll" tone="danger" />
              <Stat label="Emergency resolved (30 days)" value={payroll.emergencyResolved30d} href="/emergency-payroll?view=resolved" tone="success" />
            </div>
            {can(user, "payroll.view") && (
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                {PAYROLL_STATUSES.map((s) => (
                  <span key={s} className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
                    {PAYROLL_STATUS_LABELS[s]}: <span className="font-semibold text-foreground">{payroll.batchesByStatus[s]}</span>
                  </span>
                ))}
              </div>
            )}
          </Section>
        )}

        {payments && (
          <Section title="Ria & wire payments" href="/payments" description="Ledger totals are shown per currency and are never summed across currencies.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Awaiting approval" value={payments.pendingApprovals} href="/payments?view=approvals" tone="info" />
              <Stat label="Paid, not reconciled" value={payments.unreconciled} href="/payments?status=paid" tone="warning" />
              <Stat label="Failed" value={payments.failed} href="/payments?status=failed" tone="danger" />
              <Stat label="Reversed / returned" value={payments.reversed} href="/payments?status=reversed" tone="danger" />
            </div>
            {Object.keys(payments.totalsByCurrencyAndStatus).length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                {Object.entries(payments.totalsByCurrencyAndStatus).map(([cur, byStatus]) => (
                  <span key={cur} className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
                    {cur} reconciled: <span className="font-semibold text-foreground">{money(byStatus.reconciled ?? 0, cur)}</span> · paid (unreconciled):{" "}
                    <span className="font-semibold text-foreground">{money(byStatus.paid ?? 0, cur)}</span>
                  </span>
                ))}
              </div>
            )}
          </Section>
        )}

        {!kpi && !widgets && !payroll && !payments && (
          <Card>
            <CardBody className="text-sm text-muted-foreground">Your role has no dashboard widgets. Use the sidebar to open the areas you can access.</CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
