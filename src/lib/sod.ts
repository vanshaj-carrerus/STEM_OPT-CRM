/**
 * Separation-of-duties guards shared by payroll and payments (AC-11, AC-12; long spec §18).
 * Pure functions so they can be unit-tested and reused by API routes, server actions and the worker.
 */
export class SeparationOfDutiesError extends Error {
  status = 403;
  constructor(message: string) {
    super(message);
    this.name = "SeparationOfDutiesError";
  }
}

/** Payroll: anyone who prepared or edited the batch (any version) cannot give final approval. */
export function assertPayrollApprover(approverId: string, preparerId: string | null | undefined, editorIds: readonly string[] = []) {
  if (!preparerId) throw new SeparationOfDutiesError("This batch has no recorded preparer and cannot be approved.");
  if (approverId === preparerId || editorIds.includes(approverId)) {
    throw new SeparationOfDutiesError("You prepared or edited this payroll batch, so you cannot approve it. A different approver is required.");
  }
}

/** Payments: requester can never approve; a second approval must come from a distinct user. */
export function assertPaymentApprover(approverId: string, requesterId: string, priorApproverIds: readonly string[] = []) {
  if (approverId === requesterId) {
    throw new SeparationOfDutiesError("You requested this payment, so you cannot approve it.");
  }
  if (priorApproverIds.includes(approverId)) {
    throw new SeparationOfDutiesError("Dual approval requires two different approvers.");
  }
}

/** High-risk payments: the reconciler must be distinct from requester and every approver. */
export function assertReconciler(reconcilerId: string, requesterId: string, approverIds: readonly string[], highRisk: boolean) {
  if (!highRisk) return;
  if (reconcilerId === requesterId || approverIds.includes(reconcilerId)) {
    throw new SeparationOfDutiesError("For high-risk payments the reconciler must differ from the requester and approvers.");
  }
}

/** Emergency payroll override/manual removal must be approved by someone other than the requester. */
export function assertOverrideApprover(approverId: string, requesterId: string) {
  if (approverId === requesterId) throw new SeparationOfDutiesError("A different manager must approve an emergency payroll override.");
}
