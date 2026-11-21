import Link from "next/link";
import { loadCandidateFor, requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { audit } from "@/lib/audit";
import { candidatePayroll, listPayrollOwners } from "@/lib/payroll/queries";
import type { EmergencyStatus, PayrollStatus, ReconciliationStatus } from "@/lib/payroll/rules";
import { formatCents } from "@/lib/payroll/money";
import { formatDate, todayIn } from "@/lib/compliance/dates";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { ActionForm } from "./components/action-form";
import { BatchStatusBadge, EmergencyStatusBadge, FlagBadges, PayrollNotice } from "./components/badges";
import { clearMappingAction, mappingAction } from "@/app/(app)/payroll/actions";
import { flagEmergencyAction } from "@/app/(app)/emergency-payroll/actions";
import type { CandidateTabProps } from "../tab-types";

/** Candidate → Payroll tab: Gusto mapping, payroll history and emergency-payroll history. Amounts only with permission. */
export async function CandidatePayrollTab({ candidateId }: CandidateTabProps) {
  const user = await requirePage("payroll.view");
  const candidate = await loadCandidateFor(user, candidateId);
  if (!candidate) return <EmptyState title="Candidate not found" />;

  const { history, emergencies } = await candidatePayroll(user, candidateId);
  await audit({ actor: user, action: "read", entityType: "payroll_history", entityId: candidateId, candidateId, summary: "Viewed candidate payroll tab" });

  const showAmounts = can(user, "payroll.amounts.view");
  const canMap = can(user, "payroll.prepare");
  const canFlag = can(user, "emergency.manage");
  const m = candidate.payrollMapping;
  const hasActive = emergencies.some((e) => e.isActive);
  const owners = canFlag && !hasActive ? await listPayrollOwners() : [];

  return (
    <div className="space-y-5">
      <PayrollNotice />

      <Card>
        <CardHeader title="Gusto mapping" description="A candidate is never assumed to be a payroll employee — mapping is explicit and audited." />
        <CardBody className="space-y-4">
          {m?.employeeId ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              <Info label="Gusto employee ID">{m.employeeId}</Info>
              <Info label="Company">{m.companyRef ?? "—"}</Info>
              <Info label="Pay type">{m.payType ?? "—"}</Info>
              <Info label="Mapped">{m.mappedAt ? new Date(m.mappedAt).toLocaleDateString("en-US") : "—"}</Info>
            </dl>
          ) : (
            <Badge tone="warning">Not mapped to a Gusto employee</Badge>
          )}
          {canMap && (
            <>
              <ActionForm action={mappingAction} submit={m?.employeeId ? "Update mapping" : "Save mapping"} variant="secondary" inline>
                <input type="hidden" name="candidateId" value={candidateId} />
                <Field label="Gusto employee ID" htmlFor="map-emp" required>
                  <Input id="map-emp" name="employeeId" defaultValue={m?.employeeId ?? ""} required maxLength={64} />
                </Field>
                <Field label="Company reference" htmlFor="map-co">
                  <Input id="map-co" name="companyRef" defaultValue={m?.companyRef ?? ""} maxLength={64} />
                </Field>
                <Field label="Pay type" htmlFor="map-type">
                  <Select id="map-type" name="payType" defaultValue={m?.payType ?? ""}>
                    <option value="">—</option>
                    <option value="hourly">Hourly</option>
                    <option value="salary">Salary</option>
                    <option value="stipend">Stipend</option>
                    <option value="other">Other</option>
                  </Select>
                </Field>
                <Field label="Pay schedule" htmlFor="map-sched">
                  <Input id="map-sched" name="paySchedule" defaultValue={m?.paySchedule ?? ""} maxLength={60} />
                </Field>
              </ActionForm>
              {m?.employeeId && (
                <ActionForm action={clearMappingAction} submit="Remove mapping" variant="ghost" size="sm" inline>
                  <input type="hidden" name="candidateId" value={candidateId} />
                  <Input name="reason" placeholder="Reason (required)" required minLength={5} className="w-56" aria-label="Reason for removing the mapping" />
                </ActionForm>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Payroll history" />
        {history.length === 0 ? (
          <EmptyState title="No payroll records" description="Payroll appears here once this candidate is included in a payroll batch." />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>Pay period</TH>
                  <TH>Batch state</TH>
                  <TH>Hours</TH>
                  <TH>Pay type</TH>
                  {showAmounts && (
                    <>
                      <TH>Gross</TH>
                      <TH>Net</TH>
                    </>
                  )}
                  <TH>Exceptions</TH>
                </tr>
              </THead>
              <tbody>
                {history.map(({ item, batch }) => (
                  <TR key={item._id}>
                    <TD>
                      {batch?._id ? (
                        <Link href={`/payroll/${batch._id}`} className="text-primary hover:underline">
                          {formatDate(batch.payPeriod?.start)} – {formatDate(batch.payPeriod?.end)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TD>
                    <TD>{batch?.status && <BatchStatusBadge status={batch.status as PayrollStatus} reconciliation={(batch.reconciliation?.status ?? "pending") as ReconciliationStatus} />}</TD>
                    <TD>{item.hours ?? "—"}</TD>
                    <TD className="capitalize">{item.payType}</TD>
                    {showAmounts && (
                      <>
                        <TD>{formatCents(item.grossCents)}</TD>
                        <TD>{formatCents(item.netCents)}</TD>
                      </>
                    )}
                    <TD>{item.status === "excluded" ? <Badge>Excluded</Badge> : <FlagBadges flags={item.exceptionFlags ?? []} />}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {can(user, "emergency.view") && (
        <Card>
          <CardHeader title="Emergency payroll history" description="Resolved items stay on the record for audit and search." />
          {emergencies.length === 0 ? (
            <EmptyState title="No emergency payroll events" />
          ) : (
            <ul className="divide-y text-sm">
              {emergencies.map((e) => (
                <li key={e._id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/emergency-payroll/${e._id}`} className="font-medium text-primary hover:underline">
                      Pay deadline {formatDate(e.requestedPayDate)}
                    </Link>
                    <EmergencyStatusBadge status={e.status as EmergencyStatus} />
                    {e.resolvedVia && <span className="text-xs text-muted-foreground">resolved via {e.resolvedVia}{e.resolvedAt ? ` on ${new Date(e.resolvedAt).toLocaleDateString("en-US")}` : ""}</span>}
                  </div>
                  <p className="mt-1 text-muted-foreground">{e.reason}</p>
                </li>
              ))}
            </ul>
          )}
          {canFlag && !hasActive && (
            <CardBody className="border-t">
              <ActionForm action={flagEmergencyAction} submit="Flag for emergency payroll" variant="secondary" reset>
                <input type="hidden" name="candidateId" value={candidateId} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Requested pay date" htmlFor="ef-date" required>
                    <Input id="ef-date" name="requestedPayDate" type="date" required defaultValue={todayIn(user.timezone)} />
                  </Field>
                  <Field label="Priority" htmlFor="ef-prio">
                    <Select id="ef-prio" name="priority" defaultValue="high">
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </Select>
                  </Field>
                  <Field label="Owner" htmlFor="ef-owner">
                    <Select id="ef-owner" name="ownerId" defaultValue={user.id}>
                      {owners.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Reason" htmlFor="ef-reason" required className="sm:col-span-3">
                    <Textarea id="ef-reason" name="reason" required minLength={5} rows={2} maxLength={1000} />
                  </Field>
                </div>
              </ActionForm>
            </CardBody>
          )}
        </Card>
      )}
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
