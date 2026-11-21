import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Pencil } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { PAYMENT_TYPE_LABELS } from "@/lib/payments/rules";
import { RECEIPT_KIND_LABELS } from "@/lib/payments/evidence";
import { formatMinor } from "@/lib/payments/money";
import { fmtDateTime, fmtDate } from "@/lib/payments/ui";
import { availableCommands } from "@/lib/payments/commands";
import { getPaymentDetail } from "@/lib/payments/queries";
import { PaymentNotFoundError } from "@/lib/payments/errors";
import { auditPayment } from "@/lib/payments/core";
import { PaymentStatusBadge } from "@/modules/payments/status-badge";
import { PaymentTimeline } from "@/modules/payments/timeline";
import { CommandMenu } from "@/modules/payments/command-menu";
import { ReceiptDownloadButton, ReceiptUploadForm } from "@/modules/payments/receipt-controls";
import { RiaBanner } from "@/modules/payments/ria-banner";

export const metadata: Metadata = { title: "Payment" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2 break-words">{children ?? "—"}</dd>
    </div>
  );
}

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePage("payments.view");
  const { id } = await params;
  let d;
  try {
    d = await getPaymentDetail(user, id);
  } catch (e) {
    if (e instanceof PaymentNotFoundError) notFound();
    throw e;
  }
  const p = d.payment;
  await auditPayment(user, "read", { _id: id, candidateId: p.candidateId }, "Viewed payment");

  const decidedByMe = d.approvals.some((a) => a.approverId === user.id && a.round === p.approvalRound);
  const commands = availableCommands(user, p, { decidedByMe });
  const canEvidence = (can(user, "payments.prepare") || can(user, "payments.submit") || can(user, "payments.reconcile")) && p.status !== "cancelled";
  const wire = p.type === "domestic_wire" || p.type === "international_wire";
  const roundApprovals = d.approvals.filter((a) => a.round === p.approvalRound);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">
            <Link href="/payments" className="hover:underline">
              Payments
            </Link>{" "}
            / {p.id.slice(0, 8)}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {formatMinor(p.amountMinor, p.currency)} · {PAYMENT_TYPE_LABELS[p.type]}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <PaymentStatusBadge status={p.status} />
            {p.highRisk && <Badge tone="warning">High risk · dual approval</Badge>}
            {p.beneficiaryMismatch && <Badge tone="danger">Beneficiary mismatch</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.status === "draft" && can(user, "payments.prepare") && (
            <Button asChild variant="outline">
              <Link href={`/payments/${p.id}/edit`}>
                <Pencil className="h-4 w-4" /> Edit draft
              </Link>
            </Button>
          )}
          {(p.status === "failed" || p.status === "cancelled") && can(user, "payments.prepare") && (
            <Button asChild variant="outline">
              <Link href={`/payments/new?retry=${p.id}`}>Create replacement payment</Link>
            </Button>
          )}
          {(p.status === "paid" || p.status === "reconciled") && p.adjustmentMinor < 0 && can(user, "payments.prepare") && (
            <Button asChild variant="outline">
              <Link href={`/payments/new?linked=${p.id}`}>Create linked payment</Link>
            </Button>
          )}
        </div>
      </div>
      <RiaBanner />

      {p.flags.length > 0 && (
        <div role="alert" className="mb-5 rounded-md border border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" /> Human review required
          </p>
          <ul className="mt-1 list-inside list-disc text-xs">
            {p.flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          {p.exceptionReason && <p className="mt-1 text-xs">Reason on record: {p.exceptionReason}</p>}
        </div>
      )}

      {commands.length > 0 && (
        <Card className="mb-5">
          <CardHeader title="Actions" description="Only steps you are permitted to take right now are shown." />
          <CardBody>
            <CommandMenu paymentId={p.id} commands={commands} />
          </CardBody>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Transaction" />
          <CardBody>
            <dl className="divide-y">
              <Row label="Payment ID">
                <span className="font-mono text-xs">{p.id}</span>
              </Row>
              <Row label="Candidate">
                <Link href={`/candidates/${p.candidateId}?tab=payments`} className="text-primary hover:underline">
                  {p.candidateCode} · {p.candidateName}
                </Link>
              </Row>
              <Row label="Amount sent">{formatMinor(p.amountMinor, p.currency)}</Row>
              <Row label="Fee">{formatMinor(p.feeMinor, p.currency)}</Row>
              {p.fxRate && (
                <>
                  <Row label="FX rate">
                    {p.fxRate} {p.currency}→{p.convertedCurrency} (quoted {fmtDateTime(p.fxQuotedAt)})
                  </Row>
                  <Row label="Converted amount">{p.convertedAmountMinor !== null && p.convertedCurrency ? formatMinor(p.convertedAmountMinor, p.convertedCurrency) : "—"}</Row>
                </>
              )}
              <Row label="Net after linked events">
                {formatMinor(p.netMinor, p.currency)}
                {p.adjustmentMinor !== 0 && <span className="ml-1 text-xs text-muted-foreground">(adjustments {formatMinor(p.adjustmentMinor, p.currency)})</span>}
              </Row>
              <Row label="Reason / period">
                {p.reason}
                {(p.payPeriodStart || p.payPeriodEnd) && (
                  <span className="block text-xs text-muted-foreground">
                    {fmtDate(p.payPeriodStart)} – {fmtDate(p.payPeriodEnd)}
                  </span>
                )}
              </Row>
              <Row label="Invoice ref">{p.invoiceRef}</Row>
              <Row label="Recipient">{p.recipientName}</Row>
              {"recipientDestination" in p && <Row label="Masked destination">{p.recipientDestination}</Row>}
              <Row label="Provider reference">{p.providerReference ? `${p.providerName}: ${p.providerReference}` : null}</Row>
              {p.riskReasons.length > 0 && <Row label="Risk">{p.riskReasons.join("; ")}</Row>}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Controls" description="Who did what, and when." />
          <CardBody>
            <dl className="divide-y">
              <Row label="Created by">
                {p.createdByName} · {fmtDateTime(p.createdAt)}
              </Row>
              <Row label="Requested by">{p.requestedBy ? `${p.requestedByName ?? "—"} · ${fmtDateTime(p.requestedAt)}` : null}</Row>
              <Row label="Approved by">{p.approvedByNames.length ? `${p.approvedByNames.join(", ")} · ${fmtDateTime(p.approvedAt)}` : null}</Row>
              <Row label="Submitted by">{p.submittedBy ? `${p.submittedByName ?? "—"} · ${fmtDateTime(p.submittedAt)}` : null}</Row>
              <Row label="Paid">{p.paidAt ? `${fmtDateTime(p.paidAt)} (${p.paidVia === "provider_callback" ? "provider callback" : "manual, evidence on file"})` : null}</Row>
              <Row label="Reconciled by">
                {p.reconciledBy ? `${p.reconciledByName ?? "—"} · ${fmtDateTime(p.reconciledAt)}` : null}
                {p.reconciliation && (
                  <span className="block text-xs text-muted-foreground">
                    Statement {p.reconciliation.statementRef} · {formatMinor(p.reconciliation.settledAmountMinor, p.currency)}
                    {p.reconciliation.note ? ` · ${p.reconciliation.note}` : ""}
                  </span>
                )}
              </Row>
              {(p.linkedPaymentId || p.retryOf) && (
                <Row label="Linked to">
                  <Link className="text-primary hover:underline" href={`/payments/${p.linkedPaymentId ?? p.retryOf}`}>
                    {(p.linkedPaymentId ?? p.retryOf)!.slice(0, 8)}
                  </Link>
                  {p.retryOf ? " (replacement)" : " (adjustment)"}
                </Row>
              )}
            </dl>
          </CardBody>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Approvals" description={`Round ${p.approvalRound || "—"} · ${p.requiredApprovals} required${p.highRisk ? " (high-risk: two distinct approvers)" : ""}`} />
          <CardBody>
            {roundApprovals.length === 0 ? (
              <p className="text-sm text-muted-foreground">No decisions recorded in the current round.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {roundApprovals.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <Badge tone={a.decision === "approve" ? "success" : "danger"}>{a.decision === "approve" ? "Approved" : "Rejected"}</Badge> {a.approverName ?? "Unknown user"}
                      {a.reason && <span className="block text-xs text-muted-foreground">{a.reason}</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">{fmtDateTime(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            {d.approvals.some((a) => a.round !== p.approvalRound) && <p className="mt-3 text-xs text-muted-foreground">Earlier rounds ({d.approvals.filter((a) => a.round !== p.approvalRound).length} decisions) are kept in the timeline.</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Evidence" description="Receipts, remittance advice, bank confirmations and provider callbacks — encrypted at rest." />
          <CardBody className="space-y-4">
            {d.receipts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No evidence attached yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.receipts.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <span>
                      <Badge tone="info">{RECEIPT_KIND_LABELS[r.kind]}</Badge> {r.fileName}
                      <span className="block text-xs text-muted-foreground">
                        {fmtDateTime(r.createdAt)} · {r.uploadedByName ?? "System"} · sha256 {r.sha256.slice(0, 12)}…
                      </span>
                    </span>
                    <ReceiptDownloadButton receiptId={r.id} />
                  </li>
                ))}
              </ul>
            )}
            {canEvidence && <ReceiptUploadForm paymentId={p.id} wire={wire} />}
          </CardBody>
        </Card>
      </div>

      {(d.linked.length > 0 || d.parent) && (
        <Card className="mt-5">
          <CardHeader title="Linked payments" description="Remainders, corrections and replacements are separate ledger rows linked to the original." />
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>Relation</TH>
                  <TH>Payment</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <tbody>
                {d.parent && (
                  <TR>
                    <TD>Original / replaced</TD>
                    <TD>
                      <Link className="text-primary hover:underline" href={`/payments/${d.parent.id}`}>
                        {d.parent.id.slice(0, 8)}
                      </Link>
                    </TD>
                    <TD className="text-right tabular-nums">{formatMinor(d.parent.amountMinor, d.parent.currency)}</TD>
                    <TD>
                      <PaymentStatusBadge status={d.parent.status} />
                    </TD>
                  </TR>
                )}
                {d.linked.map((l) => (
                  <TR key={l.id}>
                    <TD>{l.retryOf === p.id ? "Replacement" : "Linked"}</TD>
                    <TD>
                      <Link className="text-primary hover:underline" href={`/payments/${l.id}`}>
                        {l.id.slice(0, 8)}
                      </Link>
                    </TD>
                    <TD className="text-right tabular-nums">{formatMinor(l.amountMinor, l.currency)}</TD>
                    <TD>
                      <PaymentStatusBadge status={l.status} />
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      )}

      <Card className="mt-5">
        <CardHeader title="Timeline" description="Append-only: status changes and partial / return / cancellation / reversal / correction events." />
        <CardBody>{d.events.length ? <PaymentTimeline events={d.events} currency={p.currency} /> : <EmptyState title="No events" />}</CardBody>
      </Card>
    </>
  );
}
