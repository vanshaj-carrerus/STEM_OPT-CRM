import { describe, expect, it } from "vitest";
import { reconcileTotals } from "@/lib/payroll/reconcile";
import { approvalBlockers, canEditBatch, computeTotals, editInvalidatesApproval, nextEditorIds, statusAfterEdit } from "@/lib/payroll/batch-rules";
import { assertPayrollApprover, SeparationOfDutiesError } from "@/lib/sod";
import { canTransitionPayroll } from "@/lib/payroll/rules";

describe("reconciliation difference math", () => {
  it("is reconciled only when register = provider = settlement AND a reference exists", () => {
    const r = reconcileTotals({ registerCents: 100000, providerCents: 100000, settlementCents: 100000, settlementReference: "ACH-1" });
    expect(r).toMatchObject({ status: "reconciled", differenceCents: 0 });
  });
  it("any difference is a mismatch with a signed difference", () => {
    const a = reconcileTotals({ registerCents: 100000, providerCents: 100500, settlementCents: 100500, settlementReference: "x" });
    expect(a.status).toBe("mismatch");
    expect(a.registerVsProviderCents).toBe(500);
    expect(a.differenceCents).toBe(500);
    const b = reconcileTotals({ registerCents: 100000, providerCents: 100000, settlementCents: 99000, settlementReference: "x" });
    expect(b).toMatchObject({ status: "mismatch", differenceCents: -1000, providerVsSettlementCents: -1000 });
  });
  it("is pending until both provider and settlement figures and a reference are entered", () => {
    expect(reconcileTotals({ registerCents: 5, providerCents: 5 }).status).toBe("pending");
    expect(reconcileTotals({ registerCents: 5, settlementCents: 5, settlementReference: "r" }).status).toBe("pending");
    expect(reconcileTotals({ registerCents: 5, providerCents: 5, settlementCents: 5 }).status).toBe("pending");
  });
  it("a mismatch is detected even while other figures are still missing", () => {
    expect(reconcileTotals({ registerCents: 100, providerCents: 101 }).status).toBe("mismatch");
    expect(reconcileTotals({ registerCents: 100, settlementCents: 90 }).status).toBe("mismatch");
  });
  it("honours an explicit tolerance only", () => {
    expect(reconcileTotals({ registerCents: 100, providerCents: 101, settlementCents: 101, settlementReference: "r", toleranceCents: 1 }).status).toBe("reconciled");
    expect(reconcileTotals({ registerCents: 100, providerCents: 102, settlementCents: 102, settlementReference: "r", toleranceCents: 1 }).status).toBe("mismatch");
  });
});

describe("batch edit rules (AC-11)", () => {
  it("only draft/needs_review/approved/failed batches are editable; processed is frozen", () => {
    for (const s of ["draft", "needs_review", "approved", "failed"] as const) expect(canEditBatch(s)).toBe(true);
    for (const s of ["processing", "processed", "voided"] as const) expect(canEditBatch(s)).toBe(false);
  });
  it("an edit after approval resets to needs_review and invalidates the approval", () => {
    expect(statusAfterEdit("approved")).toBe("needs_review");
    expect(editInvalidatesApproval("approved")).toBe(true);
    expect(canTransitionPayroll("approved", statusAfterEdit("approved"))).toBe(true);
    expect(statusAfterEdit("failed")).toBe("needs_review");
    expect(statusAfterEdit("draft")).toBe("draft");
    expect(statusAfterEdit("needs_review")).toBe("needs_review");
    expect(editInvalidatesApproval("needs_review")).toBe(false);
  });
  it("editors accumulate and can never approve — including an edit made after a prior approval", () => {
    const editors = nextEditorIds(["prep"], "prep", "late-editor");
    expect(editors.sort()).toEqual(["late-editor", "prep"]);
    expect(() => assertPayrollApprover("late-editor", "prep", editors)).toThrow(SeparationOfDutiesError);
    expect(() => assertPayrollApprover("prep", "prep", editors)).toThrow(SeparationOfDutiesError);
    expect(() => assertPayrollApprover("approver", "prep", editors)).not.toThrow();
  });
  it("blocks approval for empty batches and unmatched rows unless excluded", () => {
    expect(approvalBlockers([]).length).toBe(1);
    expect(approvalBlockers([{ status: "flagged", exceptionFlags: ["unmatched_employee"] }]).join()).toMatch(/not mapped/);
    expect(approvalBlockers([{ status: "excluded", exceptionFlags: ["unmatched_employee"] }, { status: "ok", exceptionFlags: [] }])).toEqual([]);
    expect(approvalBlockers([{ status: "flagged", exceptionFlags: ["missing_hours"] }])).toEqual([]); // non-blocking flag
  });
  it("totals skip excluded items and use integer cents", () => {
    const t = computeTotals([
      { status: "ok", hours: 10.1, grossCents: 1999, netCents: 1500, bonusesCents: 0, deductionsCents: 10, adjustmentsCents: 5 },
      { status: "flagged", hours: 0.2, grossCents: 1, netCents: null, bonusesCents: 100, deductionsCents: 0, adjustmentsCents: 0 },
      { status: "excluded", hours: 99, grossCents: 99999, netCents: 99999, bonusesCents: 0, deductionsCents: 0, adjustmentsCents: 0 },
    ]);
    expect(t).toMatchObject({ grossCents: 2000, netCents: 1500, bonusesCents: 100, deductionsCents: 10, adjustmentsCents: 5, hours: 10.3, employeeCount: 2 });
  });
});
