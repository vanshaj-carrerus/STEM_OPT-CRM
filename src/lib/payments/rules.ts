/**
 * Ria / wire payment ledger rules (long spec §8, short spec §5; AC-12/13/14).
 * Ledger rows are immutable facts: partial payments, returns, cancellations, reversals and corrections are
 * recorded as LINKED events, never by editing or deleting the original transaction.
 */

export const PAYMENT_STATUSES = [
  "draft",
  "awaiting_approval",
  "approved",
  "submitted",
  "processing",
  "paid",
  "failed",
  "cancelled",
  "reversed",
  "reconciled",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  draft: "Draft",
  awaiting_approval: "Awaiting Approval",
  approved: "Approved",
  submitted: "Submitted",
  processing: "Processing",
  paid: "Paid",
  failed: "Failed",
  cancelled: "Cancelled",
  reversed: "Reversed",
  reconciled: "Reconciled",
};

export const PAYMENT_TYPES = ["payroll_settlement", "ria_transfer", "domestic_wire", "international_wire", "reimbursement", "other"] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  payroll_settlement: "Payroll settlement (Gusto)",
  ria_transfer: "Ria transfer",
  domestic_wire: "Domestic wire",
  international_wire: "International wire",
  reimbursement: "Reimbursement",
  other: "Other",
};

const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  draft: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["approved", "draft", "cancelled"], // draft = sent back by approver
  approved: ["submitted", "cancelled"],
  submitted: ["processing", "paid", "failed", "cancelled"],
  processing: ["paid", "failed"],
  paid: ["reconciled", "reversed"],
  failed: ["cancelled"], // retry = a NEW linked payment, never re-opening this one
  cancelled: [],
  reversed: [],
  reconciled: ["reversed"], // a return after reconciliation is a linked reversal event
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus) {
  if (!canTransitionPayment(from, to)) throw new Error(`Invalid payment transition: ${from} → ${to}`);
}

/* --------------------------- Risk & approvals --------------------------- */

export const DEFAULT_HIGH_RISK_THRESHOLD_USD = 5000; // configurable in Admin → Settings; confirm with bank/finance policy

export interface RiskInput {
  type: PaymentType;
  amountUsd: number; // converted amount
  recipientChanged?: boolean;
  newRecipient?: boolean;
  thresholdUsd?: number;
}

export function isHighRisk(i: RiskInput): boolean {
  const threshold = i.thresholdUsd ?? DEFAULT_HIGH_RISK_THRESHOLD_USD;
  return i.amountUsd >= threshold || i.type === "international_wire" || !!i.recipientChanged || !!i.newRecipient;
}

/** Number of distinct approvers needed. High-risk = dual approval. */
export const requiredApprovals = (highRisk: boolean) => (highRisk ? 2 : 1);

export interface ReviewFlagInput {
  status: PaymentStatus;
  recipientChanged?: boolean;
  amountUsd: number;
  thresholdUsd?: number;
  beneficiaryMismatch?: boolean;
}

/** Human-review flags required by the spec; surfaced in the Payments center and dashboard exceptions. */
export function reviewFlags(i: ReviewFlagInput): string[] {
  const flags: string[] = [];
  if (i.recipientChanged) flags.push("Recipient changed — human review required");
  if (i.amountUsd >= (i.thresholdUsd ?? DEFAULT_HIGH_RISK_THRESHOLD_USD)) flags.push("Large amount — human review required");
  if (i.status === "failed") flags.push("Failed transfer — review required");
  if (i.status === "reversed") flags.push("Returned/reversed transfer — review required");
  if (i.beneficiaryMismatch) flags.push("Beneficiary details mismatch — review required");
  if (i.status === "paid") flags.push("Paid but not yet reconciled");
  return flags;
}

/** Unreconciled / returned items must stay visible (AC-14). */
export function needsAttention(status: PaymentStatus): boolean {
  return status === "paid" || status === "failed" || status === "reversed";
}

/* ---------------------- Totals without double counting ---------------------- */

export interface LedgerRow {
  type: PaymentType;
  status: PaymentStatus;
  amount: number;
  currency: string;
  /** Linked adjustment events (partial payments, returns, corrections). Positive = money out, negative = returned. */
  adjustments?: number[];
}

/**
 * Net settled amount per currency. Gusto payroll settlements are tracked separately from Ria/wire remittances
 * so the two are never summed into one number ("never double-count them").
 */
export function netSettled(rows: LedgerRow[]) {
  const out = { payroll: {} as Record<string, number>, remittance: {} as Record<string, number> };
  for (const r of rows) {
    if (!["paid", "reconciled"].includes(r.status)) continue;
    const bucket = r.type === "payroll_settlement" ? out.payroll : out.remittance;
    const net = r.amount + (r.adjustments ?? []).reduce((a, b) => a + b, 0);
    bucket[r.currency] = Math.round(((bucket[r.currency] ?? 0) + net) * 100) / 100;
  }
  return out;
}

/** Ria API stays disabled until the use case is approved in writing (long spec §8, §18). */
export function riaAutomationAllowed(settings: { riaContractApproved?: boolean; riaApiConfigured?: boolean }): boolean {
  return !!settings.riaContractApproved && !!settings.riaApiConfigured;
}
