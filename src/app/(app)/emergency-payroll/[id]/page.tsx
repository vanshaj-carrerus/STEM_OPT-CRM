import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { PayrollError } from "@/lib/payroll/errors";
import { getEmergencyItem, listLinkableBatches, listPayrollOwners } from "@/lib/payroll/queries";
import { resolutionCheck } from "@/lib/payroll/emergency-logic";
import { getSetting } from "@/lib/settings";
import type { EmergencyStatus, PayrollStatus, ReconciliationStatus } from "@/lib/payroll/rules";
import { formatDate } from "@/lib/compliance/dates";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { ActionForm } from "@/modules/payroll/components/action-form";
import { BatchStatusBadge, EmergencyStatusBadge, PayrollNotice } from "@/modules/payroll/components/badges";
import { decideOverrideAction, linkBatchAction, requestOverrideAction, resolveEmergencyAction, updateEmergencyAction } from "../actions";

export const metadata: Metadata = { title: "Emergency payroll item" };

const dt = (d?: string | Date | null) => (d ? new Date(d).toLocaleString("en-US") : "—");

export default async function EmergencyItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePage("emergency.view");
  let item;
  try {
    item = await getEmergencyItem(user, id);
  } catch (e) {
    if (e instanceof PayrollError && e.status === 404) notFound();
    throw e;
  }
  const status = item.status as EmergencyStatus;
  const active = item.isActive;
  const needReviewer = (await getSetting("emergencyPayroll.requireReviewer")) !== false;
  const batchState = item.batchId
    ? { status: item.batchStatus as PayrollStatus, reconciliation: (item.batchReconciliation ?? "pending") as ReconciliationStatus }
    : null;
  const check = resolutionCheck({ reviewerConfirmed: item.reviewerConfirmed, override: item.override }, batchState, { requireReviewer: needReviewer });
  const canManage = can(user, "emergency.manage");
  const canResolve = can(user, "emergency.resolve");
  const canOverride = can(user, "emergency.override");
  const [owners, batches] = active && canManage ? await Promise.all([listPayrollOwners(), listLinkableBatches()]) : [[], []];
  const o = item.override;

  return (
    <>
      <PageHeader title={`Emergency payroll — ${item.candidateName ?? "Restricted"}`} description={`${item.candidateCode ?? ""} · pay deadline ${formatDate(item.requestedPayDate)}`} actions={<EmergencyStatusBadge status={status} />} />
      <p className="mb-4 text-xs text-muted-foreground">
        <Link href="/emergency-payroll" className="hover:underline">
          ← Emergency payroll queue
        </Link>{" "}
        ·{" "}
        <Link href={`/candidates/${item.candidateId}?tab=payroll`} className="hover:underline">
          Candidate payroll record
        </Link>
      </p>

      {item.actionRequired && (
        <Card className="mb-5 border-danger/30 bg-danger-bg">
          <CardBody className="text-sm text-danger">
            <strong>Action required:</strong> {item.actionReason ?? "Review needed"}. The owner was notified, an exception task exists and the item stays in the active queue until fixed.
          </CardBody>
        </Card>
      )}

      <div className="mb-5 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Row label="Reason">{item.reason}</Row>
              <Row label="Priority">
                <span className="capitalize">{item.priority}</span>
              </Row>
              <Row label="Owner">{item.ownerName ?? "Unassigned"}</Row>
              <Row label="Requested by">{item.requestedByName ?? "—"}</Row>
              <Row label="Linked payroll batch">
                {item.batchId ? (
                  <span className="inline-flex items-center gap-2">
                    <Link href={`/payroll/${item.batchId}`} className="text-primary hover:underline">
                      {item.payrollPeriod ? `${formatDate(item.payrollPeriod.start)} – ${formatDate(item.payrollPeriod.end)}` : "Open batch"}
                    </Link>
                    {item.batchStatus && <BatchStatusBadge status={item.batchStatus as PayrollStatus} reconciliation={(item.batchReconciliation ?? "pending") as ReconciliationStatus} />}
                  </span>
                ) : (
                  "Not linked yet"
                )}
              </Row>
              <Row label="Reviewer confirmation">{item.reviewerConfirmed ? `Confirmed ${dt(item.reviewerConfirmedAt)}` : needReviewer ? "Pending" : "Not required"}</Row>
              {item.resolvedAt && <Row label="Resolved">{`${dt(item.resolvedAt)} via ${item.resolvedVia}`}</Row>}
            </dl>
            <div className="mt-4">
              <PayrollNotice />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Resolve" />
          <CardBody className="space-y-3 text-sm">
            {!active ? (
              <p className="text-muted-foreground">This item is {status}. History is preserved on the candidate record.</p>
            ) : (
              <>
                <p className={check.ok ? "text-success" : "text-muted-foreground"}>{check.ok ? "Completion and reconciliation hold — ready to resolve." : (check.reason ?? "Not ready.")}</p>
                {canResolve ? (
                  <ActionForm action={resolveEmergencyAction} submit="Confirm settlement & resolve" variant="secondary">
                    <input type="hidden" name="id" value={id} />
                    <Field label="Reviewer note (optional)" htmlFor="res-note">
                      <Input id="res-note" name="note" maxLength={1000} />
                    </Field>
                    <p className="text-xs text-muted-foreground">Resolving is rejected (409) unless payroll is Processed and reconciled, or an approved exception exists.</p>
                  </ActionForm>
                ) : (
                  <p className="text-xs text-muted-foreground">Only a payroll approver can confirm and resolve.</p>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </div>

      {active && (
        <div className="mb-5 grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Manual removal / approved exception" description="Needs a manager with override rights, a mandatory reason, and a different approver than the requester." />
            <CardBody className="space-y-4 text-sm">
              {o?.status === "pending" ? (
                <>
                  <p>
                    <Badge tone="warning">Pending</Badge> {o.kind === "removal" ? "Manual removal" : "Approved exception"} requested: “{o.reason}”
                  </p>
                  {canOverride && o.requestedBy !== user.id ? (
                    <ActionForm action={decideOverrideAction} submit="Approve" variant="primary">
                      <input type="hidden" name="id" value={id} />
                      <input type="hidden" name="decision" value="approve" />
                    </ActionForm>
                  ) : (
                    <p className="text-muted-foreground">{o.requestedBy === user.id ? "Awaiting a different manager." : "Awaiting a manager with override rights."}</p>
                  )}
                  {canOverride && o.requestedBy !== user.id && (
                    <ActionForm action={decideOverrideAction} submit="Reject" variant="outline">
                      <input type="hidden" name="id" value={id} />
                      <input type="hidden" name="decision" value="reject" />
                      <Field label="Note" htmlFor="rej-note">
                        <Input id="rej-note" name="note" maxLength={1000} />
                      </Field>
                    </ActionForm>
                  )}
                </>
              ) : (
                (canManage || canOverride) && (
                  <ActionForm action={requestOverrideAction} submit="Request approval">
                    <input type="hidden" name="id" value={id} />
                    {o?.status === "rejected" && <p className="text-xs text-muted-foreground">The last request was rejected{o.decisionNote ? `: ${o.decisionNote}` : ""}.</p>}
                    <Field label="Type" htmlFor="ov-kind">
                      <Select id="ov-kind" name="kind" defaultValue="exception">
                        <option value="exception">Approved exception (resolve without reconciliation)</option>
                        <option value="removal">Manual removal from queue</option>
                      </Select>
                    </Field>
                    <Field label="Mandatory reason" htmlFor="ov-reason" required>
                      <Textarea id="ov-reason" name="reason" required minLength={5} rows={2} maxLength={1000} />
                    </Field>
                  </ActionForm>
                )
              )}
            </CardBody>
          </Card>

          {canManage && (
            <Card>
              <CardHeader title="Edit & link" />
              <CardBody className="space-y-4">
                <ActionForm action={updateEmergencyAction} submit="Save changes" variant="secondary">
                  <input type="hidden" name="id" value={id} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Owner" htmlFor="u-owner">
                      <Select id="u-owner" name="ownerId" defaultValue={item.ownerId ?? ""}>
                        {owners.map((ow) => (
                          <option key={ow.id} value={ow.id}>
                            {ow.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Priority" htmlFor="u-prio">
                      <Select id="u-prio" name="priority" defaultValue={item.priority}>
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                        <option value="urgent">Urgent</option>
                      </Select>
                    </Field>
                    <Field label="Pay deadline" htmlFor="u-date">
                      <Input id="u-date" name="requestedPayDate" type="date" defaultValue={item.requestedPayDate} />
                    </Field>
                  </div>
                </ActionForm>
                <ActionForm action={linkBatchAction} submit="Link batch" variant="outline" inline>
                  <input type="hidden" name="id" value={id} />
                  <Field label="Payroll batch" htmlFor="u-batch">
                    <Select id="u-batch" name="batchId" defaultValue={item.batchId ?? ""} required>
                      <option value="" disabled>
                        Select…
                      </option>
                      {batches.map((b) => (
                        <option key={b._id} value={b._id}>
                          {b.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </ActionForm>
              </CardBody>
            </Card>
          )}
        </div>
      )}

      <Card>
        <CardHeader title="Resolution history" description="Every state change, approval and override is logged with actor and time." />
        <ul className="divide-y text-sm">
          {[...item.history].reverse().map((h, i) => (
            <li key={i} className="px-5 py-3">
              <span className="font-medium">{h.action.replace(/_/g, " ")}</span>
              {h.toStatus && <span className="text-muted-foreground"> {h.fromStatus ? `${h.fromStatus} → ` : ""}{h.toStatus}</span>}
              <span className="text-muted-foreground"> · {h.byName ?? "System"} · {dt(h.at)}</span>
              {h.note && <span className="block text-xs text-muted-foreground">{h.note}</span>}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
