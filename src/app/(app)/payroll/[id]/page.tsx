import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { PayrollError } from "@/lib/payroll/errors";
import { getBatchDetail, listMappedCandidates, type BatchDetail } from "@/lib/payroll/queries";
import { canEditBatch } from "@/lib/payroll/batch-rules";
import type { PayrollStatus, ReconciliationStatus } from "@/lib/payroll/rules";
import { formatCents } from "@/lib/payroll/money";
import { formatDate } from "@/lib/compliance/dates";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { ActionForm } from "@/modules/payroll/components/action-form";
import { BatchStatusBadge, FlagBadges, PayrollNotice } from "@/modules/payroll/components/badges";
import { RegisterImport } from "@/modules/payroll/components/import-form";
import { ReconcileForm } from "@/modules/payroll/components/reconcile-form";
import { GustoBanner } from "@/modules/payroll/sections/gusto-banner";
import {
  approveBatchAction, commitImportAction, correctionBatchAction, evidenceAction, excludeItemAction, markFailedAction, markSubmittedAction,
  previewImportAction, reconcileAction, rejectBatchAction, removeItemAction, reopenFailedAction, saveItemAction, submitReviewAction, voidBatchAction,
} from "../actions";

export const metadata: Metadata = { title: "Payroll batch" };

const dt = (d?: string | Date | null) => (d ? new Date(d).toLocaleString("en-US") : "—");

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePage("payroll.view");
  let detail: BatchDetail;
  try {
    detail = await getBatchDetail(user, id);
  } catch (e) {
    if (e instanceof PayrollError && e.status === 404) notFound();
    throw e;
  }
  const { batch: b, items, logs, editorNames } = detail;
  const status = b.status as PayrollStatus;
  const recStatus = (b.reconciliation?.status ?? "pending") as ReconciliationStatus;
  const showAmounts = can(user, "payroll.amounts.view");
  const canPrepare = can(user, "payroll.prepare");
  const canApprove = can(user, "payroll.approve");
  const canReconcile = can(user, "payroll.reconcile");
  const editable = canEditBatch(status);
  const iEdited = (b.editorIds ?? []).includes(user.id);
  const mapped = canPrepare && editable && showAmounts ? await listMappedCandidates(user) : [];
  const hidden = <input type="hidden" name="batchId" value={id} />;

  return (
    <>
      <PageHeader
        title={`Payroll ${formatDate(b.payPeriod?.start)} – ${formatDate(b.payPeriod?.end)}`}
        description={`Pay date ${formatDate(b.payPeriod?.payDate)}${b.kind === "adjustment" ? " · correction batch" : ""}`}
        actions={<BatchStatusBadge status={status} reconciliation={recStatus} />}
      />
      <p className="mb-4 text-xs text-muted-foreground">
        <Link href="/payroll" className="hover:underline">
          ← All payroll batches
        </Link>
      </p>
      <GustoBanner />

      {b.rejection && status === "draft" && (
        <Card className="mb-5 border-warning/30 bg-warning-bg">
          <CardBody className="text-sm">
            <strong>Returned for changes</strong> — {b.rejection.reason}
          </CardBody>
        </Card>
      )}
      {status === "failed" && (
        <Card className="mb-5 border-danger/30 bg-danger-bg">
          <CardBody className="text-sm text-danger">Payroll failed{b.failureReason ? `: ${b.failureReason}` : ""}. An exception task was created.</CardBody>
        </Card>
      )}
      {status === "processed" && recStatus === "mismatch" && (
        <Card className="mb-5 border-danger/30 bg-danger-bg">
          <CardBody className="text-sm text-danger">Reconciliation mismatch — marked for review. An exception task was created.</CardBody>
        </Card>
      )}
      {(detail.adjusts || detail.linkedCorrections.length > 0) && (
        <p className="mb-4 text-sm text-muted-foreground">
          {detail.adjusts && (
            <>
              Corrects processed batch{" "}
              <Link className="text-primary hover:underline" href={`/payroll/${detail.adjusts._id}`}>
                {detail.adjusts._id.slice(0, 8)}
              </Link>
              .{" "}
            </>
          )}
          {detail.linkedCorrections.map((c) => (
            <Link key={c._id} className="mr-2 text-primary hover:underline" href={`/payroll/${c._id}`}>
              Correction {c._id.slice(0, 8)} ({c.status})
            </Link>
          ))}
        </p>
      )}

      <div className="mb-5 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Batch summary" />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Item label="Gusto company">{b.companyRef ?? "—"}</Item>
              <Item label="Gusto payroll ID (provider reference)">{b.externalRef ?? "—"}</Item>
              <Item label="Processed">
                {b.processedAt ? `${dt(b.processedAt)} (${b.processedVia === "webhook" ? "verified provider event" : "manual provider evidence"})` : "—"}
              </Item>
              <Item label="Pay-statement reference">{b.payStatementRef ?? "—"}</Item>
              <Item label="Prepared by">{b.preparedByName ?? "—"}</Item>
              <Item label="Edited by">{editorNames.join(", ") || "—"}</Item>
              <Item label="Approved by">{b.approvedByName ? `${b.approvedByName} · ${dt(b.approvedAt)}` : "—"}</Item>
              <Item label="Version">{b.version}</Item>
              {showAmounts && b.totals && (
                <>
                  <Item label="Gross total">{formatCents(b.totals.grossCents, b.totals.currency)}</Item>
                  <Item label="Net total">{formatCents(b.totals.netCents, b.totals.currency)}</Item>
                  <Item label="Bonuses / adjustments / deductions">
                    {formatCents(b.totals.bonusesCents)} / {formatCents(b.totals.adjustmentsCents)} / {formatCents(b.totals.deductionsCents)}
                  </Item>
                  <Item label="Employees · hours">
                    {b.totals.employeeCount} · {b.totals.hours}
                  </Item>
                </>
              )}
              {!showAmounts && <Item label="Amounts">Hidden — requires the payroll amounts permission.</Item>}
            </dl>
            {b.reconciliation?.status !== "pending" || b.reconciliation?.at ? (
              <p className="mt-4 text-xs text-muted-foreground">
                Last reconciliation: {recStatus}
                {b.reconciliation?.settlementReference ? ` · ref ${b.reconciliation.settlementReference}` : ""}
                {showAmounts && typeof b.reconciliation?.differenceCents === "number" && b.reconciliation.differenceCents !== 0 ? ` · difference ${formatCents(b.reconciliation.differenceCents)}` : ""}
              </p>
            ) : null}
            <div className="mt-4">
              <PayrollNotice />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Approval & workflow" />
          <CardBody className="space-y-4 text-sm">
            {status === "draft" && canPrepare && (
              <ActionForm action={submitReviewAction} submit="Submit for review">
                {hidden}
              </ActionForm>
            )}
            {status === "needs_review" && (
              <>
                {iEdited ? (
                  <p className="rounded-md bg-muted p-3 text-muted-foreground">
                    {canApprove ? "You prepared or edited this batch, so you cannot approve it. " : ""}Awaiting a different approver.
                  </p>
                ) : canApprove ? (
                  <ActionForm action={approveBatchAction} submit="Approve batch">
                    {hidden}
                  </ActionForm>
                ) : (
                  <p className="text-muted-foreground">Awaiting approval by a payroll approver.</p>
                )}
                {canApprove && (
                  <ActionForm action={rejectBatchAction} submit="Return for changes" variant="outline">
                    {hidden}
                    <Field label="Reason" htmlFor="reject-reason">
                      <Input id="reject-reason" name="reason" required minLength={5} />
                    </Field>
                  </ActionForm>
                )}
              </>
            )}
            {status === "approved" && (canPrepare || canApprove) && (
              <>
                <p className="text-muted-foreground">Approved. Any edit now resets the batch to Needs Review and requires a fresh approval.</p>
                <ActionForm action={markSubmittedAction} submit="Record: submitted to Gusto">
                  {hidden}
                  <Field label="Gusto payroll ID (if known)" htmlFor="sub-ref">
                    <Input id="sub-ref" name="externalRef" maxLength={128} />
                  </Field>
                </ActionForm>
              </>
            )}
            {(status === "approved" || status === "processing") && (canReconcile || canApprove) && (
              <ActionForm action={evidenceAction} submit="Record provider evidence: processed" variant="secondary">
                {hidden}
                <p className="text-xs text-muted-foreground">
                  Completion is never taken from the browser. Enter the evidence you reviewed in Gusto; this is audited. A verified Gusto webhook can also set this.
                </p>
                <Field label="Gusto payroll ID (provider reference)" htmlFor="ev-ref" required>
                  <Input id="ev-ref" name="externalRef" defaultValue={b.externalRef ?? ""} required maxLength={128} />
                </Field>
                <Field label="Processing date" htmlFor="ev-date" required>
                  <Input id="ev-date" name="processedDate" type="date" required />
                </Field>
                <Field label="Pay-statement reference (optional)" htmlFor="ev-stmt">
                  <Input id="ev-stmt" name="payStatementRef" maxLength={128} />
                </Field>
                <Field label="Evidence reviewed" htmlFor="ev-note" required>
                  <Textarea id="ev-note" name="note" required minLength={5} rows={2} />
                </Field>
              </ActionForm>
            )}
            {status === "processing" && (canPrepare || canApprove || canReconcile) && (
              <ActionForm action={markFailedAction} submit="Record failure" variant="outline">
                {hidden}
                <Field label="Failure reason" htmlFor="fail-reason">
                  <Input id="fail-reason" name="reason" required minLength={5} />
                </Field>
              </ActionForm>
            )}
            {status === "failed" && canPrepare && (
              <>
                <ActionForm action={reopenFailedAction} submit="Reopen for correction" variant="secondary">
                  {hidden}
                </ActionForm>
                <ActionForm action={markSubmittedAction} submit="Record: re-submitted to Gusto" variant="outline">
                  {hidden}
                  <input type="hidden" name="externalRef" value={b.externalRef ?? ""} />
                </ActionForm>
              </>
            )}
            {status === "processed" && canPrepare && (
              <ActionForm action={correctionBatchAction} submit="Create linked correction batch" variant="outline">
                {hidden}
                <p className="text-xs text-muted-foreground">Processed payroll is never edited or deleted. Corrections are separate batches linked to this one.</p>
                <Field label="Reason" htmlFor="corr-reason">
                  <Input id="corr-reason" name="reason" required minLength={5} />
                </Field>
              </ActionForm>
            )}
            {status === "voided" && <p className="text-muted-foreground">Voided{b.voidedReason ? `: ${b.voidedReason}` : ""}.</p>}
            {status !== "processed" && status !== "voided" && (canPrepare || canApprove) && (
              <ActionForm action={voidBatchAction} submit="Void batch" variant="danger">
                {hidden}
                <Field label="Void reason" htmlFor="void-reason">
                  <Input id="void-reason" name="reason" required minLength={5} />
                </Field>
              </ActionForm>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mb-5">
        <CardHeader title="Payroll items" description="Hours, pay type, approved adjustments, bonuses, deductions and exception flags per candidate." />
        {items.length === 0 ? (
          <EmptyState title="No items yet" description="Add items manually or import the Gusto payroll register CSV." />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>Employee</TH>
                  <TH>Hours</TH>
                  <TH>Pay type</TH>
                  {showAmounts && (
                    <>
                      <TH>Gross</TH>
                      <TH>Net</TH>
                      <TH>Adjustments</TH>
                      <TH>Bonuses</TH>
                      <TH>Deductions</TH>
                    </>
                  )}
                  <TH>Exceptions</TH>
                  {canPrepare && editable && <TH>Actions</TH>}
                </tr>
              </THead>
              <tbody>
                {items.map((i) => (
                  <TR key={i._id} className={i.status === "excluded" ? "opacity-60" : undefined}>
                    <TD>
                      {i.candidateId ? (
                        <Link href={`/candidates/${i.candidateId}?tab=payroll`} className="font-medium text-primary hover:underline">
                          {i.candidateName}
                        </Link>
                      ) : (
                        <span className="font-medium">{i.candidateName ?? "Unmatched"}</span>
                      )}
                      <span className="block text-xs text-muted-foreground">Gusto ID {i.externalEmployeeRef}</span>
                      {i.adjustmentNote && <span className="block text-xs text-muted-foreground">{i.adjustmentNote}</span>}
                    </TD>
                    <TD>{i.hours ?? "—"}</TD>
                    <TD className="capitalize">{i.payType}</TD>
                    {showAmounts && (
                      <>
                        <TD>{formatCents(i.grossCents)}</TD>
                        <TD>{formatCents(i.netCents)}</TD>
                        <TD>{formatCents(i.adjustmentsCents)}</TD>
                        <TD>{formatCents(i.bonusesCents)}</TD>
                        <TD>{formatCents(i.deductionsCents)}</TD>
                      </>
                    )}
                    <TD>
                      {i.status === "excluded" ? <Badge>Excluded: {i.excludedReason}</Badge> : <FlagBadges flags={i.exceptionFlags ?? []} />}
                    </TD>
                    {canPrepare && editable && (
                      <TD>
                        <div className="flex flex-col gap-1">
                          {i.status === "excluded" ? (
                            <ActionForm action={excludeItemAction} submit="Include" size="sm" variant="outline" inline>
                              {hidden}
                              <input type="hidden" name="itemId" value={i._id} />
                              <input type="hidden" name="exclude" value="0" />
                            </ActionForm>
                          ) : (
                            <ActionForm action={excludeItemAction} submit="Exclude" size="sm" variant="outline" inline>
                              {hidden}
                              <input type="hidden" name="itemId" value={i._id} />
                              <input type="hidden" name="exclude" value="1" />
                              <Input name="reason" placeholder="Reason" required minLength={5} className="h-8 w-32 text-xs" aria-label="Exclusion reason" />
                            </ActionForm>
                          )}
                          <ActionForm action={removeItemAction} submit="Remove" size="sm" variant="ghost" inline>
                            {hidden}
                            <input type="hidden" name="itemId" value={i._id} />
                          </ActionForm>
                        </div>
                      </TD>
                    )}
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {canPrepare && editable && showAmounts && (
        <div className="mb-5 grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Add or update an item" description={mapped.length ? undefined : "No candidates are mapped to Gusto yet — map them first."} />
            <CardBody>
              <ActionForm action={saveItemAction} submit="Save item" reset>
                {hidden}
                <Field label="Candidate (mapped to Gusto)" htmlFor="item-candidate" required>
                  <Select id="item-candidate" name="candidateId" required defaultValue="">
                    <option value="" disabled>
                      Select…
                    </option>
                    {mapped.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Hours" htmlFor="item-hours">
                    <Input id="item-hours" name="hours" inputMode="decimal" />
                  </Field>
                  <Field label="Pay type" htmlFor="item-type">
                    <Select id="item-type" name="payType" defaultValue="hourly">
                      <option value="hourly">Hourly</option>
                      <option value="salary">Salary</option>
                      <option value="stipend">Stipend</option>
                      <option value="other">Other</option>
                    </Select>
                  </Field>
                  <Field label="Gross pay" htmlFor="item-gross">
                    <Input id="item-gross" name="gross" inputMode="decimal" placeholder="0.00" />
                  </Field>
                  <Field label="Net pay" htmlFor="item-net">
                    <Input id="item-net" name="net" inputMode="decimal" placeholder="0.00" />
                  </Field>
                  <Field label="Bonuses" htmlFor="item-bonus">
                    <Input id="item-bonus" name="bonuses" inputMode="decimal" placeholder="0.00" />
                  </Field>
                  <Field label="Deductions" htmlFor="item-ded">
                    <Input id="item-ded" name="deductions" inputMode="decimal" placeholder="0.00" />
                  </Field>
                  <Field label="Approved adjustments" htmlFor="item-adj">
                    <Input id="item-adj" name="adjustments" inputMode="decimal" placeholder="0.00" />
                  </Field>
                  <Field label="Adjustment note" htmlFor="item-note" className="sm:col-span-2">
                    <Input id="item-note" name="adjustmentNote" maxLength={500} />
                  </Field>
                </div>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Import Gusto payroll register (CSV)" />
            <CardBody>
              <RegisterImport batchId={id} preview={previewImportAction} commit={commitImportAction} />
            </CardBody>
          </Card>
        </div>
      )}

      {status === "processed" && canReconcile && showAmounts && (
        <Card className="mb-5">
          <CardHeader title="Reconciliation" description="Compare the CRM register total with the Gusto report total and the actual settlement. Any difference marks the batch for review." />
          <CardBody>
            <ReconcileForm
              batchId={id}
              registerCents={b.totals?.netCents ?? 0}
              action={reconcileAction}
              defaults={{
                providerCents: b.reconciliation?.providerTotalCents,
                settlementCents: b.reconciliation?.settlementTotalCents,
                settlementReference: b.reconciliation?.settlementReference,
                note: b.reconciliation?.note,
              }}
            />
          </CardBody>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Approval history" />
          {(b.approvalHistory ?? []).length === 0 ? (
            <EmptyState title="No approval activity yet" />
          ) : (
            <ul className="divide-y text-sm">
              {[...(b.approvalHistory ?? [])].reverse().map((a, idx) => (
                <li key={idx} className="px-5 py-3">
                  <span className="font-medium capitalize">{a.action.replace("_", " ")}</span> by {detail.names[a.by] ?? "Unknown"} · v{a.version} · {dt(a.at)}
                  {a.reason && <span className="block text-xs text-muted-foreground">{a.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Sync & import log (this batch)" />
          {logs.length === 0 ? (
            <EmptyState title="No log entries" />
          ) : (
            <ul className="divide-y text-sm">
              {logs.map((l) => (
                <li key={l._id} className="px-5 py-3">
                  <Badge tone={l.level === "error" ? "danger" : l.level === "warn" ? "warning" : "neutral"}>{l.kind}</Badge> {l.message}
                  <span className="block text-xs text-muted-foreground">{dt(l.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
