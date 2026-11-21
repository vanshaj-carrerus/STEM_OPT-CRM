import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { listEmergencyItems, listLinkableBatches, listPayrollOwners } from "@/lib/payroll/queries";
import type { EmergencyStatus } from "@/lib/payroll/rules";
import { formatDate, todayIn } from "@/lib/compliance/dates";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { ActionForm } from "@/modules/payroll/components/action-form";
import { EmergencyStatusBadge, PayrollNotice } from "@/modules/payroll/components/badges";
import { cn } from "@/lib/utils";
import { flagEmergencyAction } from "./actions";

export const metadata: Metadata = { title: "Emergency payroll" };

export default async function EmergencyPayrollPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("emergency.view");
  const sp = await searchParams;
  const view = sp.view === "resolved" ? "resolved" : "active";
  const { rows, total } = await listEmergencyItems(user, { view, q: sp.q, page: Number(sp.page) || 1 });
  const canFlag = can(user, "emergency.manage");
  const [owners, batches] = canFlag ? await Promise.all([listPayrollOwners(), listLinkableBatches()]) : [[], []];
  const today = todayIn(user.timezone);

  return (
    <>
      <PageHeader title="Emergency payroll" description="Temporary queue for candidates who need off-cycle payroll. Items stay here until payroll is processed AND reconciled." />
      <nav className="mb-5 flex gap-1 border-b" aria-label="Emergency payroll views">
        {(["active", "resolved"] as const).map((v) => (
          <Link
            key={v}
            href={`/emergency-payroll?view=${v}`}
            aria-current={v === view ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3.5 py-2.5 text-sm font-medium", v === view ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {v === "active" ? "Active queue" : "Resolved history"}
          </Link>
        ))}
      </nav>

      {canFlag && view === "active" && (
        <Card className="mb-5">
          <CardHeader title="Flag a candidate for emergency payroll" description="Creates a queue item with an owner. It is a temporary flag, not a candidate status." />
          <CardBody>
            <ActionForm action={flagEmergencyAction} submit="Add to queue" reset>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Candidate code" htmlFor="f-code" required hint="e.g. CND-000123">
                  <Input id="f-code" name="candidateCode" required placeholder="CND-000000" />
                </Field>
                <Field label="Requested pay date" htmlFor="f-date" required>
                  <Input id="f-date" name="requestedPayDate" type="date" required defaultValue={today} />
                </Field>
                <Field label="Priority" htmlFor="f-prio">
                  <Select id="f-prio" name="priority" defaultValue="high">
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </Select>
                </Field>
                <Field label="Owner" htmlFor="f-owner">
                  <Select id="f-owner" name="ownerId" defaultValue={user.id}>
                    {owners.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Linked payroll batch (optional)" htmlFor="f-batch">
                  <Select id="f-batch" name="batchId" defaultValue="">
                    <option value="">Not linked yet</option>
                    {batches.map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reason" htmlFor="f-reason" required className="md:col-span-3">
                  <Textarea id="f-reason" name="reason" required minLength={5} rows={2} maxLength={1000} />
                </Field>
              </div>
            </ActionForm>
          </CardBody>
        </Card>
      )}

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 border-b p-4">
          <input type="hidden" name="view" value={view} />
          <Input name="q" defaultValue={sp.q ?? ""} placeholder="Search candidate, code or reason…" className="w-72" />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        {rows.length === 0 ? (
          <EmptyState title={view === "active" ? "No active emergency payroll items" : "No resolved items found"} />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>Candidate</TH>
                  <TH>Reason</TH>
                  <TH>Pay deadline</TH>
                  <TH>Current state</TH>
                  <TH>Owner</TH>
                  <TH>Exception</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((r) => {
                  const overdue = r.isActive && r.requestedPayDate < today;
                  return (
                    <TR key={r._id}>
                      <TD>
                        <Link href={`/emergency-payroll/${r._id}`} className="font-medium text-primary hover:underline">
                          {r.candidateName ?? "Restricted"}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{r.candidateCode}</span>
                      </TD>
                      <TD className="max-w-xs truncate" title={r.reason}>
                        {r.reason}
                      </TD>
                      <TD>
                        {formatDate(r.requestedPayDate)}
                        {overdue && <Badge tone="danger" className="ml-2">Past deadline</Badge>}
                      </TD>
                      <TD>
                        <EmergencyStatusBadge status={r.status as EmergencyStatus} />
                        {view === "resolved" && r.resolvedVia && <span className="block text-xs text-muted-foreground">via {r.resolvedVia}</span>}
                      </TD>
                      <TD>{r.ownerName ?? "Unassigned"}</TD>
                      <TD>
                        {r.actionRequired ? (
                          <Badge tone="danger">
                            <AlertTriangle className="h-3 w-3" /> {r.actionReason ?? "Action required"}
                          </Badge>
                        ) : r.override?.status === "pending" ? (
                          <Badge tone="warning">Override pending approval</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <div className="border-t px-4 py-3 text-xs text-muted-foreground">
          {total} item{total === 1 ? "" : "s"}. <PayrollNotice />
        </div>
      </Card>
    </>
  );
}
