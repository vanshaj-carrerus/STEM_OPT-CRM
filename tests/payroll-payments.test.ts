import { describe, expect, it } from "vitest";
import {
  canResolveEmergency,
  canTransitionPayroll,
  deriveEmergencyStatus,
  isActiveEmergency,
  payrollDisplayState,
  validateOverride,
} from "@/lib/payroll/rules";
import {
  canTransitionPayment,
  isHighRisk,
  netSettled,
  needsAttention,
  requiredApprovals,
  reviewFlags,
  riaAutomationAllowed,
} from "@/lib/payments/rules";
import {
  SeparationOfDutiesError,
  assertPaymentApprover,
  assertPayrollApprover,
  assertReconciler,
} from "@/lib/sod";

describe("payroll state machine", () => {
  it("follows Draft → Needs Review → Approved → Processing → Processed", () => {
    expect(canTransitionPayroll("draft", "needs_review")).toBe(true);
    expect(canTransitionPayroll("needs_review", "approved")).toBe(true);
    expect(canTransitionPayroll("approved", "processing")).toBe(true);
    expect(canTransitionPayroll("processing", "processed")).toBe(true);
    expect(canTransitionPayroll("draft", "processed")).toBe(false); // cannot skip approval
    expect(canTransitionPayroll("draft", "approved")).toBe(false);
  });
  it("completed payroll can never be voided/deleted in place", () => {
    expect(canTransitionPayroll("processed", "voided")).toBe(false);
    expect(canTransitionPayroll("processed", "draft")).toBe(false);
  });
  it("shows Completed-Pending-Reconciliation until reconciled", () => {
    expect(payrollDisplayState("processed", "pending")).toBe("Completed-Pending-Reconciliation");
    expect(payrollDisplayState("processed", "reconciled")).toMatch(/Reconciled/);
  });
});

describe("AC-09 / AC-10: emergency payroll queue", () => {
  it.each(["draft", "needs_review", "approved", "processing"] as const)("stays active while payroll is %s", (s) => {
    const st = deriveEmergencyStatus({ payrollStatus: s });
    expect(isActiveEmergency(st)).toBe(true);
    if (s === "processing") expect(st).toBe("processing");
  });
  it("stays active (Action Required) when payroll failed or voided", () => {
    expect(deriveEmergencyStatus({ payrollStatus: "failed" })).toBe("action_required");
    expect(deriveEmergencyStatus({ payrollStatus: "voided" })).toBe("action_required");
  });
  it("completed payroll alone does NOT remove the item — it waits for reconciliation", () => {
    const st = deriveEmergencyStatus({ payrollStatus: "processed", reconciliation: "pending" });
    expect(st).toBe("pending_reconciliation");
    expect(isActiveEmergency(st)).toBe(true);
    expect(canResolveEmergency({ payrollStatus: "processed", reconciliation: "pending" }).ok).toBe(false);
  });
  it("reconciled but not reviewer-confirmed stays active", () => {
    expect(deriveEmergencyStatus({ payrollStatus: "processed", reconciliation: "reconciled", reviewerConfirmed: false })).toBe("pending_reconciliation");
  });
  it("mismatch keeps item active and flags action required", () => {
    expect(deriveEmergencyStatus({ payrollStatus: "processed", reconciliation: "mismatch", reviewerConfirmed: true })).toBe("action_required");
  });
  it("leaves the active queue only after processed + reconciled + reviewer confirmation", () => {
    const st = deriveEmergencyStatus({ payrollStatus: "processed", reconciliation: "reconciled", reviewerConfirmed: true });
    expect(st).toBe("resolved");
    expect(isActiveEmergency(st)).toBe(false);
  });
  it("submitted/processing can never be resolved, even if reconciled flag is set", () => {
    expect(deriveEmergencyStatus({ payrollStatus: "processing", reconciliation: "reconciled", reviewerConfirmed: true })).toBe("processing");
  });
  it("approved exception or manual removal requires a reason", () => {
    expect(deriveEmergencyStatus({ payrollStatus: "failed", exceptionApproved: true, exceptionReason: " " })).toBe("action_required");
    expect(deriveEmergencyStatus({ payrollStatus: "failed", exceptionApproved: true, exceptionReason: "Paid by check, verified" })).toBe("resolved");
    expect(deriveEmergencyStatus({ payrollStatus: "processing", manualRemovalApproved: true, manualRemovalReason: "Duplicate request" })).toBe("removed");
    expect(validateOverride({ reason: "", requesterId: "a", approverId: "b" }).ok).toBe(false);
    expect(validateOverride({ reason: "Valid reason", requesterId: "a", approverId: "a" }).ok).toBe(false);
    expect(validateOverride({ reason: "Valid reason", requesterId: "a", approverId: "b" }).ok).toBe(true);
  });
});

describe("AC-11: payroll separation of duties", () => {
  it("preparer cannot approve own batch; editors cannot approve either", () => {
    expect(() => assertPayrollApprover("u1", "u1")).toThrow(SeparationOfDutiesError);
    expect(() => assertPayrollApprover("u2", "u1", ["u2"])).toThrow(SeparationOfDutiesError);
    expect(() => assertPayrollApprover("u3", "u1", ["u2"])).not.toThrow();
  });
});

describe("payment ledger state machine", () => {
  it("follows the spec statuses and blocks skipping approval", () => {
    expect(canTransitionPayment("draft", "awaiting_approval")).toBe(true);
    expect(canTransitionPayment("awaiting_approval", "approved")).toBe(true);
    expect(canTransitionPayment("approved", "submitted")).toBe(true);
    expect(canTransitionPayment("paid", "reconciled")).toBe(true);
    expect(canTransitionPayment("draft", "submitted")).toBe(false);
    expect(canTransitionPayment("draft", "paid")).toBe(false);
  });
  it("failed payments are never re-opened (retry = new linked payment); reconciled can only be reversed via linked event", () => {
    expect(canTransitionPayment("failed", "approved")).toBe(false);
    expect(canTransitionPayment("reconciled", "reversed")).toBe(true);
    expect(canTransitionPayment("reconciled", "draft")).toBe(false);
  });
});

describe("AC-12: payment approvals", () => {
  it("requester can never approve; dual approval needs two distinct approvers", () => {
    expect(() => assertPaymentApprover("r", "r")).toThrow(SeparationOfDutiesError);
    expect(() => assertPaymentApprover("a1", "r", ["a1"])).toThrow(SeparationOfDutiesError);
    expect(() => assertPaymentApprover("a2", "r", ["a1"])).not.toThrow();
  });
  it("high risk = big amount, international wire, new/changed recipient → 2 approvals", () => {
    expect(isHighRisk({ type: "ria_transfer", amountUsd: 200 })).toBe(false);
    expect(isHighRisk({ type: "ria_transfer", amountUsd: 6000 })).toBe(true);
    expect(isHighRisk({ type: "international_wire", amountUsd: 10 })).toBe(true);
    expect(isHighRisk({ type: "ria_transfer", amountUsd: 10, recipientChanged: true })).toBe(true);
    expect(requiredApprovals(true)).toBe(2);
    expect(requiredApprovals(false)).toBe(1);
  });
  it("high-risk reconciler differs from requester and approvers", () => {
    expect(() => assertReconciler("r", "r", ["a1", "a2"], true)).toThrow(SeparationOfDutiesError);
    expect(() => assertReconciler("a1", "r", ["a1", "a2"], true)).toThrow(SeparationOfDutiesError);
    expect(() => assertReconciler("f", "r", ["a1", "a2"], true)).not.toThrow();
    expect(() => assertReconciler("r", "r", ["a1"], false)).not.toThrow();
  });
});

describe("AC-14: unreconciled / returned stays flagged; no double counting", () => {
  it("flags paid-but-unreconciled, failed and reversed", () => {
    expect(needsAttention("paid")).toBe(true);
    expect(needsAttention("failed")).toBe(true);
    expect(needsAttention("reversed")).toBe(true);
    expect(needsAttention("reconciled")).toBe(false);
    expect(reviewFlags({ status: "reversed", amountUsd: 10 }).join()).toMatch(/Returned/);
  });
  it("keeps Gusto payroll and Ria/wire remittances in separate buckets and nets adjustments", () => {
    const r = netSettled([
      { type: "payroll_settlement", status: "reconciled", amount: 1000, currency: "USD" },
      { type: "ria_transfer", status: "paid", amount: 500, currency: "USD", adjustments: [-100] },
      { type: "domestic_wire", status: "failed", amount: 999, currency: "USD" },
    ]);
    expect(r.payroll.USD).toBe(1000);
    expect(r.remittance.USD).toBe(400);
  });
  it("Ria automation stays off until contract-approved AND api configured", () => {
    expect(riaAutomationAllowed({})).toBe(false);
    expect(riaAutomationAllowed({ riaContractApproved: true })).toBe(false);
    expect(riaAutomationAllowed({ riaContractApproved: true, riaApiConfigured: true })).toBe(true);
  });
});
