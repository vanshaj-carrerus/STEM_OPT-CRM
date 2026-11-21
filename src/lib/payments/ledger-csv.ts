import { csvEscape } from "@/lib/csv";
import { formatMinorPlain } from "./money";
import { PAYMENT_STATUS_LABELS, PAYMENT_TYPE_LABELS } from "./rules";
import type { PaymentView } from "./view";

/**
 * Ledger CSV. Uses the shared escaper (formula-injection safe) and the already field-stripped PaymentView, so a
 * role without payments.destination.view can never obtain the destination reference through an export.
 * Amounts are exact decimal strings (no floats).
 */
export function buildLedgerCsv(rows: PaymentView[], opts: { includeDestination: boolean }): string {
  const cols: { head: string; get: (r: PaymentView) => unknown }[] = [
    { head: "Payment ID", get: (r) => r.id },
    { head: "Created", get: (r) => r.createdAt },
    { head: "Candidate code", get: (r) => r.candidateCode },
    { head: "Candidate", get: (r) => r.candidateName },
    { head: "Type", get: (r) => PAYMENT_TYPE_LABELS[r.type] },
    { head: "Status", get: (r) => PAYMENT_STATUS_LABELS[r.status] },
    { head: "Amount", get: (r) => formatMinorPlain(r.amountMinor, r.currency) },
    { head: "Currency", get: (r) => r.currency },
    { head: "Fee", get: (r) => formatMinorPlain(r.feeMinor, r.currency) },
    { head: "FX rate", get: (r) => r.fxRate },
    { head: "FX quoted at", get: (r) => r.fxQuotedAt },
    { head: "Converted amount", get: (r) => (r.convertedAmountMinor === null || !r.convertedCurrency ? "" : formatMinorPlain(r.convertedAmountMinor, r.convertedCurrency)) },
    { head: "Converted currency", get: (r) => r.convertedCurrency },
    { head: "Net amount (after linked events)", get: (r) => formatMinorPlain(r.netMinor, r.currency) },
    { head: "Reason / period", get: (r) => r.reason },
    { head: "Recipient", get: (r) => r.recipientName },
    ...(opts.includeDestination ? [{ head: "Masked destination", get: (r: PaymentView) => r.recipientDestination }] : []),
    { head: "Provider", get: (r) => r.providerName },
    { head: "Provider reference", get: (r) => r.providerReference },
    { head: "High risk", get: (r) => (r.highRisk ? "yes" : "no") },
    { head: "Review flags", get: (r) => r.flags.join("; ") },
    { head: "Created by", get: (r) => r.createdByName ?? r.createdBy },
    { head: "Approved by", get: (r) => r.approvedByNames.join("; ") },
    { head: "Submitted at", get: (r) => r.submittedAt },
    { head: "Paid at", get: (r) => r.paidAt },
    { head: "Reconciled by", get: (r) => r.reconciledByName ?? r.reconciledBy },
    { head: "Reconciled at", get: (r) => r.reconciledAt },
    { head: "Linked payment", get: (r) => r.linkedPaymentId },
    { head: "Retry of", get: (r) => r.retryOf },
  ];
  const lines = [cols.map((c) => csvEscape(c.head)).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(c.get(r))).join(","));
  return lines.join("\r\n");
}
