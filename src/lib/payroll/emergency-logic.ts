import {
  canResolveEmergency,
  deriveEmergencyStatus,
  isActiveEmergency,
  validateOverride,
  type EmergencyInputs,
  type EmergencyStatus,
  type PayrollStatus,
  type ReconciliationStatus,
} from "./rules";

/**
 * Pure glue between an emergency item, its linked batch and the foundation rules. `deriveItemStatus` is the ONLY
 * function the service layer uses to compute an item's status, so state cannot drift between mutations.
 */

export const EMERGENCY_LABELS: Record<EmergencyStatus, string> = {
  open: "Open",
  processing: "Processing",
  pending_reconciliation: "Completed-Pending-Reconciliation",
  action_required: "Action Required",
  resolved: "Resolved",
  removed: "Removed (approved)",
};

export interface OverrideRecord {
  kind: "exception" | "removal";
  reason: string;
  requestedBy: string;
  status: "pending" | "approved" | "rejected";
  decidedBy?: string | null;
}

export interface EmergencyItemState {
  reviewerConfirmed?: boolean;
  override?: OverrideRecord | null;
}

export interface BatchState {
  status: PayrollStatus;
  reconciliation: ReconciliationStatus;
  /** Set while the batch sits in Draft after an approver rejected it for changes. */
  rejected?: boolean;
}

export function buildEmergencyInputs(item: EmergencyItemState, batch: BatchState | null | undefined, opts: { requireReviewer: boolean }): EmergencyInputs {
  const o = item.override;
  const approved = o?.status === "approved";
  return {
    payrollStatus: batch?.status,
    reconciliation: batch?.reconciliation,
    // when the org setting disables the reviewer step, reconciliation alone is enough
    reviewerConfirmed: opts.requireReviewer ? !!item.reviewerConfirmed : true,
    exceptionApproved: approved && o?.kind === "exception",
    exceptionReason: approved && o?.kind === "exception" ? o.reason : null,
    manualRemovalApproved: approved && o?.kind === "removal",
    manualRemovalReason: approved && o?.kind === "removal" ? o.reason : null,
  };
}

export function deriveItemStatus(item: EmergencyItemState, batch: BatchState | null | undefined, opts: { requireReviewer: boolean }): EmergencyStatus {
  const status = deriveEmergencyStatus(buildEmergencyInputs(item, batch, opts));
  // A batch an approver rejected back to Draft is "rejected": the item must not look like routine work in progress.
  if (status === "open" && batch?.rejected) return "action_required";
  return status;
}

/** Why an item is in Action Required (shown in the queue and used for the exception task). */
export function actionRequiredReason(batch: BatchState | null | undefined): string | null {
  if (!batch) return null;
  if (batch.status === "failed") return "Payroll failed";
  if (batch.status === "voided") return "Payroll was voided";
  if (batch.reconciliation === "mismatch") return "Reconciliation mismatch";
  if (batch.rejected) return "Payroll batch was rejected for changes";
  return null;
}

/** Can this item be resolved now? (used by the resolve endpoint — the actor's confirmation counts as the reviewer step) */
export function resolutionCheck(item: EmergencyItemState, batch: BatchState | null | undefined, opts: { requireReviewer: boolean }) {
  const inputs = buildEmergencyInputs({ ...item, reviewerConfirmed: true }, batch, opts);
  if (batch?.reconciliation === "mismatch" && batch.status === "processed") return { ok: false, reason: "Reconciliation shows a mismatch — resolve the difference first." };
  return canResolveEmergency(inputs);
}

export function overrideAllowed(p: { reason?: string | null; requesterId: string; approverId: string }) {
  return validateOverride(p);
}

export const isActive = isActiveEmergency;
