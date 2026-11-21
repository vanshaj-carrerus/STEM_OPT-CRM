import Link from "next/link";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";
import { listBatches } from "@/lib/payroll/queries";
import { PAYROLL_STATUSES, PAYROLL_STATUS_LABELS, type PayrollStatus, type ReconciliationStatus } from "@/lib/payroll/rules";
import { formatCents } from "@/lib/payroll/money";
import { formatDate } from "@/lib/compliance/dates";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/form";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { BatchStatusBadge } from "../components/badges";

type SP = Record<string, string | undefined>;

export async function BatchesSection({ user, sp }: { user: SessionUser; sp: SP }) {
  const { rows, total, page, pageSize } = await listBatches(user, {
    status: sp.status || undefined, reconciliation: sp.reconciliation || undefined, from: sp.from || undefined, to: sp.to || undefined, page: Number(sp.page) || 1,
  });
  const showAmounts = can(user, "payroll.amounts.view");
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const keep = (over: Record<string, string>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) u.set(k, v);
    return `?${u}`;
  };

  return (
    <Card>
      <form method="get" className="flex flex-wrap items-end gap-3 border-b p-4">
        <input type="hidden" name="tab" value="batches" />
        <Select name="status" defaultValue={sp.status ?? ""} className="w-44" aria-label="Status">
          <option value="">All statuses</option>
          {PAYROLL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PAYROLL_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <Select name="reconciliation" defaultValue={sp.reconciliation ?? ""} className="w-52" aria-label="Reconciliation">
          <option value="">Any reconciliation</option>
          <option value="pending">Processed · pending reconciliation</option>
          <option value="reconciled">Processed · reconciled</option>
          <option value="mismatch">Processed · mismatch</option>
        </Select>
        <label className="text-xs text-muted-foreground">
          Pay date from <Input name="from" type="date" defaultValue={sp.from ?? ""} className="mt-1 w-40" />
        </label>
        <label className="text-xs text-muted-foreground">
          to <Input name="to" type="date" defaultValue={sp.to ?? ""} className="mt-1 w-40" />
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        <Button asChild variant="ghost">
          <Link href="/payroll">Reset</Link>
        </Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No payroll batches" description="Create a batch for a pay period to start tracking payroll." />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <tr>
                <TH>Pay period</TH>
                <TH>Pay date</TH>
                <TH>Status</TH>
                <TH>Approval</TH>
                <TH>Gusto payroll ID</TH>
                {showAmounts && <TH>Net total</TH>}
                <TH>Prepared by</TH>
              </tr>
            </THead>
            <tbody>
              {rows.map((b) => {
                const status = b.status as PayrollStatus;
                const mine = (b.editorIds ?? []).includes(user.id);
                return (
                  <TR key={b._id}>
                    <TD>
                      <Link href={`/payroll/${b._id}`} className="font-medium text-primary hover:underline">
                        {formatDate(b.payPeriod?.start)} – {formatDate(b.payPeriod?.end)}
                      </Link>
                      {b.kind === "adjustment" && <Badge tone="info" className="ml-2">Correction</Badge>}
                    </TD>
                    <TD>{formatDate(b.payPeriod?.payDate)}</TD>
                    <TD>
                      <BatchStatusBadge status={status} reconciliation={(b.reconciliation?.status ?? "pending") as ReconciliationStatus} />
                    </TD>
                    <TD className="text-xs text-muted-foreground">
                      {status === "needs_review"
                        ? mine
                          ? "Awaiting a different approver"
                          : can(user, "payroll.approve")
                            ? "Ready for your approval"
                            : "Awaiting approval"
                        : b.approvedByName
                          ? `Approved by ${b.approvedByName}`
                          : "—"}
                    </TD>
                    <TD>{b.externalRef ?? "—"}</TD>
                    {showAmounts && <TD>{b.totals ? formatCents(b.totals.netCents, b.totals.currency) : "—"}</TD>}
                    <TD>{b.preparedByName ?? "—"}</TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
      <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
        <span>
          {total} batch{total === 1 ? "" : "es"} · page {page} of {pages}
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
      </div>
    </Card>
  );
}
