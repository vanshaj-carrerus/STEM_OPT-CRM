import type { Metadata } from "next";
import Link from "next/link";
import { Download, Plus } from "lucide-react";
import { loadCandidateFor, requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { cn } from "@/lib/utils";
import { PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, PAYMENT_TYPES, PAYMENT_TYPE_LABELS } from "@/lib/payments/rules";
import { COMMON_CURRENCIES } from "@/lib/payments/money";
import { listPayments, paymentsDashboard, type PaymentFilters } from "@/lib/payments/queries";
import { PaymentTable } from "@/modules/payments/payment-table";
import { RiaBanner } from "@/modules/payments/ria-banner";
import { CandidatePicker } from "@/modules/payments/candidate-picker";

export const metadata: Metadata = { title: "Ria & wire payments" };

type SP = Record<string, string | undefined>;

const VIEWS = [
  { key: "all", label: "Ledger" },
  { key: "attention", label: "Needs attention" },
  { key: "approvals", label: "Pending my approval" },
] as const;

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePage("payments.view");
  const sp = await searchParams;
  const canApprove = can(user, "payments.approve");
  const view = (VIEWS.find((v) => v.key === sp.view && (v.key !== "approvals" || canApprove))?.key ?? "all") as PaymentFilters["view"];

  const filters: PaymentFilters = {
    view,
    candidateId: sp.candidateId || undefined,
    type: sp.type || undefined,
    status: sp.status || undefined,
    currency: sp.currency || undefined,
    from: sp.from || undefined,
    to: sp.to || undefined,
    q: sp.q || undefined,
    page: Number(sp.page) || 1,
    pageSize: 25,
  };
  const [{ rows, total, page, pageSize }, dash, mine] = await Promise.all([
    listPayments(user, filters),
    paymentsDashboard(user),
    canApprove ? listPayments(user, { view: "approvals", pageSize: 1 }) : Promise.resolve({ total: 0 }),
  ]);
  const candidate = filters.candidateId ? await loadCandidateFor(user, filters.candidateId) : null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const attention = dash.byStatus.paid + dash.byStatus.failed + dash.byStatus.reversed;

  const keep = (over: Record<string, string>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) u.set(k, v);
    return `?${u}`;
  };
  const exportQuery = new URLSearchParams(Object.entries({ ...sp, page: undefined, view: view === "attention" ? "attention" : undefined }).filter(([, v]) => v) as [string, string][]).toString();
  const canExport = can(user, "reports.export") || can(user, "payments.reconcile");


  const kpis = [
    { label: "Awaiting approval", value: dash.pendingApprovals, href: "?status=awaiting_approval" },
    ...(canApprove ? [{ label: "Pending my approval", value: mine.total, href: "?view=approvals" }] : []),
    { label: "Paid, not reconciled", value: dash.unreconciled, href: "?status=paid" },
    { label: "Failed", value: dash.failed, href: "?status=failed" },
    { label: "Returned / reversed", value: dash.reversed, href: "?status=reversed" },
  ];

  return (
    <>
      <PageHeader
        title="Ria & wire payments"
        description="Candidate-wise ledger with dual approval, evidence and reconciliation. Ledger rows are immutable; adjustments are linked events."
        actions={
          <>
            {canExport && (
              <Button asChild variant="outline">
                <a href={`/api/payments/export?${exportQuery}`}>
                  <Download className="h-4 w-4" /> Export CSV
                </a>
              </Button>
            )}
            {can(user, "payments.prepare") && (
              <Button asChild>
                <Link href="/payments/new">
                  <Plus className="h-4 w-4" /> New payment
                </Link>
              </Button>
            )}
          </>
        }
      />
      <RiaBanner />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        {kpis.map((k) => (
          <Link key={k.label} href={`/payments${k.href}`} className="rounded-lg border bg-card p-4 shadow-sm hover:bg-muted/40">
            <p className="text-xs text-muted-foreground">{k.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{k.value}</p>
          </Link>
        ))}
      </div>

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b" aria-label="Payment views">
        {VIEWS.filter((v) => v.key !== "approvals" || canApprove).map((v) => (
          <Link
            key={v.key}
            href={keep({ view: v.key === "all" ? "" : v.key, page: "" })}
            aria-current={v.key === view ? "page" : undefined}
            className={cn("-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium", v.key === view ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {v.label}
            {v.key === "attention" && <span className="ml-1.5 text-xs text-muted-foreground">({attention})</span>}
            {v.key === "approvals" && <span className="ml-1.5 text-xs text-muted-foreground">({mine.total})</span>}
          </Link>
        ))}
      </nav>

      {view === "approvals" && (
        <p className="mb-3 text-sm text-muted-foreground">Payments you requested or created are never shown here — a different approver must decide them.</p>
      )}
      {view === "attention" && <p className="mb-3 text-sm text-muted-foreground">Paid-but-unreconciled, failed, returned/reversed and beneficiary-mismatch payments stay here until resolved.</p>}

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 border-b p-4">
          {view !== "all" && <input type="hidden" name="view" value={view} />}
          <div className="w-64">
            <CandidatePicker defaultCandidate={candidate ? { id: candidate._id, label: `${candidate.candidateCode} · ${candidate.legalName}` } : undefined} />
          </div>
          <Input name="q" defaultValue={sp.q ?? ""} placeholder="Recipient, reference, reason…" className="w-56" />
          <Select name="type" defaultValue={sp.type ?? ""} className="w-44">
            <option value="">All types</option>
            {PAYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {PAYMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          {view !== "approvals" && (
            <Select name="status" defaultValue={sp.status ?? ""} className="w-44">
              <option value="">All statuses</option>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PAYMENT_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
          <Select name="currency" defaultValue={sp.currency ?? ""} className="w-28">
            <option value="">Currency</option>
            {COMMON_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Input name="from" type="date" defaultValue={sp.from ?? ""} className="w-40" title="Created on or after" />
          <Input name="to" type="date" defaultValue={sp.to ?? ""} className="w-40" title="Created on or before" />
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          <Button asChild variant="ghost">
            <Link href={view === "all" ? "/payments" : `/payments?view=${view}`}>Reset</Link>
          </Button>
        </form>

        <PaymentTable rows={rows} showDestination={can(user, "payments.destination.view")} />

        <CardBody className="flex flex-wrap items-center justify-between gap-3 border-t py-3 text-xs text-muted-foreground">
          <span>
            {total.toLocaleString()} payment{total === 1 ? "" : "s"} · page {page} of {pages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={keep({ page: String(page - 1) })}>Previous</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild variant="outline" size="sm">
                <Link href={keep({ page: String(page + 1) })}>Next</Link>
              </Button>
            )}
          </div>
        </CardBody>
      </Card>
    </>
  );
}
