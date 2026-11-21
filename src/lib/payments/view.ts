import type { Actor } from "@/lib/rbac/can";
import { PAYMENT_FIELD_RULES, stripRestricted } from "@/lib/rbac/mask";
import type { IPayment } from "@/lib/db/models/payment";
import { needsAttention, reviewFlags, type PaymentStatus, type PaymentType } from "./rules";

/** Serializable payment shape for pages and APIs. `recipientDestination` is removed (not blanked) without payments.destination.view. */
export interface PaymentView {
  id: string;
  candidateId: string;
  candidateCode?: string;
  candidateName?: string;
  type: PaymentType;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  feeMinor: number;
  fxRate: string | null;
  fxQuotedAt: string | null;
  convertedAmountMinor: number | null;
  convertedCurrency: string | null;
  amountUsdMinor: number | null;
  adjustmentMinor: number;
  netMinor: number;
  reason: string;
  payPeriodStart: string | null;
  payPeriodEnd: string | null;
  invoiceRef: string | null;
  recipientName: string | null;
  recipientDestination?: string | null;
  providerName: string | null;
  providerReference: string | null;
  highRisk: boolean;
  riskReasons: string[];
  requiredApprovals: number;
  approvalRound: number;
  newRecipient: boolean;
  recipientChanged: boolean;
  beneficiaryMismatch: boolean;
  beneficiaryMismatchNote: string | null;
  flags: string[];
  needsAttention: boolean;
  createdBy: string;
  createdByName?: string;
  requestedBy: string | null;
  requestedByName?: string;
  approvedBy: string[];
  approvedByNames: string[];
  submittedBy: string | null;
  submittedByName?: string;
  reconciledBy: string | null;
  reconciledByName?: string;
  createdAt: string;
  requestedAt: string | null;
  approvedAt: string | null;
  submittedAt: string | null;
  paidAt: string | null;
  paidVia: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  reversedAt: string | null;
  reconciledAt: string | null;
  exceptionReason: string | null;
  reconciliation: { statementRef: string; settledAmountMinor: number; statementDate: string | null; note: string | null } | null;
  linkedPaymentId: string | null;
  retryOf: string | null;
}

export interface ViewContext {
  thresholdUsd: number;
  candidates?: Record<string, { code: string; name: string }>;
  users?: Record<string, string>;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function toPaymentView(actor: Actor, p: IPayment, ctx: ViewContext): PaymentView {
  const usd = p.amountUsdMinor === null || p.amountUsdMinor === undefined ? 0 : p.amountUsdMinor / 100;
  const flags = reviewFlags({
    status: p.status,
    recipientChanged: p.recipientChanged,
    amountUsd: usd,
    thresholdUsd: ctx.thresholdUsd,
    beneficiaryMismatch: p.beneficiaryMismatch,
  });
  if (p.newRecipient && ["draft", "awaiting_approval", "approved"].includes(p.status)) flags.push("New recipient — human review required");
  if (p.adjustmentMinor < 0 && p.status !== "reversed") flags.push("Partial payment or return recorded — net amount reduced");
  const cand = ctx.candidates?.[p.candidateId];
  const name = (id?: string | null) => (id ? ctx.users?.[id] : undefined);
  const view: PaymentView = {
    id: p._id,
    candidateId: p.candidateId,
    candidateCode: cand?.code,
    candidateName: cand?.name,
    type: p.type,
    status: p.status,
    amountMinor: p.amountMinor,
    currency: p.currency,
    feeMinor: p.feeMinor ?? 0,
    fxRate: p.fxRate ?? null,
    fxQuotedAt: iso(p.fxQuotedAt),
    convertedAmountMinor: p.convertedAmountMinor ?? null,
    convertedCurrency: p.convertedCurrency ?? null,
    amountUsdMinor: p.amountUsdMinor ?? null,
    adjustmentMinor: p.adjustmentMinor ?? 0,
    netMinor: p.amountMinor + (p.adjustmentMinor ?? 0),
    reason: p.reason,
    payPeriodStart: p.payPeriodStart ?? null,
    payPeriodEnd: p.payPeriodEnd ?? null,
    invoiceRef: p.invoiceRef ?? null,
    recipientName: p.recipientName ?? null,
    recipientDestination: p.recipientDestination ?? null,
    providerName: p.providerName ?? null,
    providerReference: p.providerReference ?? null,
    highRisk: p.highRisk,
    riskReasons: p.riskReasons ?? [],
    requiredApprovals: p.requiredApprovals,
    approvalRound: p.approvalRound,
    newRecipient: p.newRecipient,
    recipientChanged: p.recipientChanged,
    beneficiaryMismatch: p.beneficiaryMismatch,
    beneficiaryMismatchNote: p.beneficiaryMismatchNote ?? null,
    flags,
    needsAttention: needsAttention(p.status) || p.beneficiaryMismatch,
    createdBy: p.createdBy,
    createdByName: name(p.createdBy),
    requestedBy: p.requestedBy ?? null,
    requestedByName: name(p.requestedBy),
    approvedBy: p.approvedBy ?? [],
    approvedByNames: (p.approvedBy ?? []).map((id) => name(id) ?? "Unknown user"),
    submittedBy: p.submittedBy ?? null,
    submittedByName: name(p.submittedBy),
    reconciledBy: p.reconciledBy ?? null,
    reconciledByName: name(p.reconciledBy),
    createdAt: new Date(p.createdAt).toISOString(),
    requestedAt: iso(p.requestedAt),
    approvedAt: iso(p.approvedAt),
    submittedAt: iso(p.submittedAt),
    paidAt: iso(p.paidAt),
    paidVia: p.paidVia ?? null,
    failedAt: iso(p.failedAt),
    cancelledAt: iso(p.cancelledAt),
    reversedAt: iso(p.reversedAt),
    reconciledAt: iso(p.reconciledAt),
    exceptionReason: p.exceptionReason ?? null,
    reconciliation: p.reconciliation ? { statementRef: p.reconciliation.statementRef, settledAmountMinor: p.reconciliation.settledAmountMinor, statementDate: p.reconciliation.statementDate ?? null, note: p.reconciliation.note ?? null } : null,
    linkedPaymentId: p.linkedPaymentId ?? null,
    retryOf: p.retryOf ?? null,
  };
  // field-level security: the destination reference is stripped entirely for roles without payments.destination.view
  return stripRestricted(actor, view as unknown as Record<string, unknown>, PAYMENT_FIELD_RULES) as unknown as PaymentView;
}
