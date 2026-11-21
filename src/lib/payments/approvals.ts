import type { PaymentStatus } from "./rules";

/**
 * Approval progress for one approval ROUND of a payment (pure).
 *  - the requester (and anyone else excluded, e.g. the draft's creator) can never count as an approver
 *  - the same approver counted twice only counts once (duplicates ignored)
 *  - high-risk payments need two distinct approvers; any rejection stops the round
 */
export interface ApprovalRow {
  approverId: string;
  decision: "approve" | "reject";
}

export interface ApprovalProgress {
  required: number;
  approvedIds: string[];
  count: number;
  remaining: number;
  rejected: boolean;
  satisfied: boolean;
  ignored: { approverId: string; reason: "excluded" | "duplicate" }[];
}

export function approvalProgress(input: {
  required: number;
  excludedIds: readonly string[]; // requester (+ creator)
  approvals: readonly ApprovalRow[];
}): ApprovalProgress {
  const excluded = new Set(input.excludedIds);
  const approved: string[] = [];
  const ignored: ApprovalProgress["ignored"] = [];
  let rejected = false;
  for (const a of input.approvals) {
    if (excluded.has(a.approverId)) {
      ignored.push({ approverId: a.approverId, reason: "excluded" });
      continue;
    }
    if (a.decision === "reject") {
      rejected = true;
      continue;
    }
    if (approved.includes(a.approverId)) {
      ignored.push({ approverId: a.approverId, reason: "duplicate" });
      continue;
    }
    approved.push(a.approverId);
  }
  const count = approved.length;
  return {
    required: input.required,
    approvedIds: approved,
    count,
    remaining: Math.max(0, input.required - count),
    rejected,
    satisfied: !rejected && count >= input.required,
    ignored,
  };
}

/** Money fields freeze once a payment leaves Draft (so in-flight/finished approvals can't be bypassed). */
export const MONEY_FIELDS = [
  "candidateId",
  "type",
  "amountMinor",
  "currency",
  "feeMinor",
  "fxRate",
  "fxQuotedAt",
  "convertedAmountMinor",
  "convertedCurrency",
  "amountUsdMinor",
  "recipientName",
  "recipientDestination",
  "recipientFingerprint",
  "reason",
  "payPeriodStart",
  "payPeriodEnd",
  "invoiceRef",
  "linkedPaymentId",
  "retryOf",
] as const;

export function isMoneyEditable(status: PaymentStatus): boolean {
  return status === "draft";
}

/** Returns the frozen fields that a change set would touch for a payment in `status` ([] = allowed). */
export function frozenViolations(status: PaymentStatus, changedKeys: readonly string[]): string[] {
  if (isMoneyEditable(status)) return [];
  const frozen = new Set<string>(MONEY_FIELDS);
  return changedKeys.filter((k) => frozen.has(k));
}
