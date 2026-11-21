/**
 * Payroll batch + emergency payroll rules (long spec §6/§7, short spec §4, AC-09/10/11).
 * Gusto is the system of record: the CRM mirrors state and never decides that payroll "completed" on a
 * browser-supplied value — the caller must pass a status verified from a provider response or human reconciliation.
 */

export const PAYROLL_STATUSES = ["draft", "needs_review", "approved", "processing", "processed", "failed", "voided"] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export const PAYROLL_STATUS_LABELS: Record<PayrollStatus, string> = {
  draft: "Draft",
  needs_review: "Needs Review",
  approved: "Approved",
  processing: "Processing",
  processed: "Processed",
  failed: "Failed",
  voided: "Voided",
};

export const RECONCILIATION_STATUSES = ["pending", "reconciled", "mismatch"] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

const TRANSITIONS: Record<PayrollStatus, PayrollStatus[]> = {
  draft: ["needs_review", "voided"],
  needs_review: ["draft", "approved", "voided"], // back to draft = rejected for changes
  approved: ["processing", "needs_review", "voided"],
  processing: ["processed", "failed", "voided"],
  processed: [], // completed payroll is never deleted/voided in place — correct via a linked adjustment
  failed: ["needs_review", "processing", "voided"],
  voided: [],
};

export function canTransitionPayroll(from: PayrollStatus, to: PayrollStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertPayrollTransition(from: PayrollStatus, to: PayrollStatus) {
  if (!canTransitionPayroll(from, to)) throw new Error(`Invalid payroll transition: ${from} → ${to}`);
}

/** Display label for the combined processed + reconciliation state (long spec §6: Completed-Pending-Reconciliation). */
export function payrollDisplayState(status: PayrollStatus, rec: ReconciliationStatus): string {
  if (status === "processed") {
    if (rec === "reconciled") return "Processed · Reconciled";
    if (rec === "mismatch") return "Processed · Mismatch (action required)";
    return "Completed-Pending-Reconciliation";
  }
  return PAYROLL_STATUS_LABELS[status];
}

/* ------------------------- Emergency payroll queue ------------------------- */

export const EMERGENCY_STATUSES = ["open", "processing", "pending_reconciliation", "action_required", "resolved", "removed"] as const;
export type EmergencyStatus = (typeof EMERGENCY_STATUSES)[number];

/** Items in these states stay in the active Emergency Payroll queue. */
export function isActiveEmergency(s: EmergencyStatus): boolean {
  return s !== "resolved" && s !== "removed";
}

export interface EmergencyInputs {
  /** Linked batch state; undefined when no batch is linked yet. */
  payrollStatus?: PayrollStatus;
  reconciliation?: ReconciliationStatus;
  /** Reviewer has confirmed settlement/evidence (required in addition to the reconciled flag). */
  reviewerConfirmed?: boolean;
  /** Approved exception workflow (manager approval + mandatory reason). */
  exceptionApproved?: boolean;
  exceptionReason?: string | null;
  /** Manual removal approved by an authorized manager with a mandatory reason. */
  manualRemovalApproved?: boolean;
  manualRemovalReason?: string | null;
}

/**
 * Single source of truth for an emergency item's status. Never resolves on submitted/processing (AC-09);
 * resolves only when payroll is Processed AND reconciliation is reconciled AND a reviewer confirmed (AC-10),
 * or via an approved exception / manual removal with a reason.
 */
export function deriveEmergencyStatus(i: EmergencyInputs): EmergencyStatus {
  if (i.manualRemovalApproved && i.manualRemovalReason?.trim()) return "removed";
  if (i.exceptionApproved && i.exceptionReason?.trim()) return "resolved";

  const p = i.payrollStatus;
  if (p === "failed" || p === "voided") return "action_required";
  if (i.reconciliation === "mismatch") return "action_required";
  if (p === "processed") {
    return i.reconciliation === "reconciled" && i.reviewerConfirmed ? "resolved" : "pending_reconciliation";
  }
  if (p === "processing") return "processing";
  return "open";
}

export function canResolveEmergency(i: EmergencyInputs): { ok: boolean; reason?: string } {
  const s = deriveEmergencyStatus(i);
  if (s === "resolved" || s === "removed") return { ok: true };
  if (i.payrollStatus !== "processed") return { ok: false, reason: "Payroll is not completed (Processed). Submitted/processing items stay active." };
  if (i.reconciliation !== "reconciled") return { ok: false, reason: "Payment is not reconciled yet." };
  if (!i.reviewerConfirmed) return { ok: false, reason: "A reviewer must confirm settlement evidence." };
  return { ok: false, reason: "Item cannot be resolved." };
}

/** Manual removal / exception requires a reason and a different manager than the requester. */
export function validateOverride(p: { reason?: string | null; requesterId: string; approverId: string }): { ok: true } | { ok: false; error: string } {
  if (!p.reason || p.reason.trim().length < 5) return { ok: false, error: "A mandatory reason (min 5 characters) is required." };
  if (p.requesterId === p.approverId) return { ok: false, error: "A different authorized manager must approve the override." };
  return { ok: true };
}
