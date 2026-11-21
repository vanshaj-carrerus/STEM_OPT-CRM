import { describe, expect, it } from "vitest";
import { actionRequiredReason, buildEmergencyInputs, deriveItemStatus, resolutionCheck, EMERGENCY_LABELS, type BatchState } from "@/lib/payroll/emergency-logic";
import { isActiveEmergency, payrollDisplayState, type EmergencyStatus } from "@/lib/payroll/rules";

const REQ = { requireReviewer: true };
const noReq = { requireReviewer: false };
const b = (status: BatchState["status"], reconciliation: BatchState["reconciliation"] = "pending", rejected = false): BatchState => ({ status, reconciliation, rejected });

/** Re-derive after each event of a sequence, exactly as syncEmergencyItems does. */
function run(events: { batch: BatchState | null; reviewer?: boolean; override?: Parameters<typeof deriveItemStatus>[0]["override"] }[], opts = REQ): EmergencyStatus[] {
  return events.map((e) => deriveItemStatus({ reviewerConfirmed: e.reviewer, override: e.override }, e.batch, opts));
}

describe("emergency payroll: event table (AC-09 / AC-10)", () => {
  it("submitted/processing → stays visible & Processing, never auto-removed", () => {
    expect(run([{ batch: b("draft") }, { batch: b("needs_review") }, { batch: b("approved") }, { batch: b("processing") }])).toEqual(["open", "open", "open", "processing"]);
    for (const s of run([{ batch: b("approved") }, { batch: b("processing") }])) expect(isActiveEmergency(s)).toBe(true);
  });
  it("processed (reconciliation pending) → Completed-Pending-Reconciliation, flag retained", () => {
    const [s] = run([{ batch: b("processed", "pending") }]);
    expect(s).toBe("pending_reconciliation");
    expect(isActiveEmergency(s)).toBe(true);
    expect(EMERGENCY_LABELS[s]).toBe("Completed-Pending-Reconciliation");
    expect(payrollDisplayState("processed", "pending")).toBe("Completed-Pending-Reconciliation");
  });
  it("reconciled + reviewer confirmation → Resolved and leaves the active queue", () => {
    const [s] = run([{ batch: b("processed", "reconciled"), reviewer: true }]);
    expect(s).toBe("resolved");
    expect(isActiveEmergency(s)).toBe(false);
  });
  it("reconciled but reviewer not confirmed stays pending when a reviewer is required; resolves when the setting is off", () => {
    expect(run([{ batch: b("processed", "reconciled"), reviewer: false }])[0]).toBe("pending_reconciliation");
    expect(run([{ batch: b("processed", "reconciled"), reviewer: false }], noReq)[0]).toBe("resolved");
  });
  it("failed / voided / rejected / mismatch → Action Required and stays active", () => {
    const seq = run([{ batch: b("failed") }, { batch: b("voided") }, { batch: b("draft", "pending", true) }, { batch: b("processed", "mismatch"), reviewer: true }]);
    expect(seq).toEqual(["action_required", "action_required", "action_required", "action_required"]);
    seq.forEach((s) => expect(isActiveEmergency(s)).toBe(true));
  });
  it("full lifecycle sequence including a failure and recovery", () => {
    const seq = run([
      { batch: null },
      { batch: b("draft") },
      { batch: b("needs_review") },
      { batch: b("approved") },
      { batch: b("processing") },
      { batch: b("failed") },
      { batch: b("processing") },
      { batch: b("processed", "pending") },
      { batch: b("processed", "mismatch") },
      { batch: b("processed", "reconciled"), reviewer: false },
      { batch: b("processed", "reconciled"), reviewer: true },
    ]);
    expect(seq).toEqual(["open", "open", "open", "open", "processing", "action_required", "processing", "pending_reconciliation", "action_required", "pending_reconciliation", "resolved"]);
  });
  it("a reviewer confirmation never survives into a non-reconciled state", () => {
    expect(run([{ batch: b("processed", "pending"), reviewer: true }], REQ)[0]).toBe("pending_reconciliation");
  });
  it("rejected is a draft-only concept", () => {
    expect(deriveItemStatus({}, b("needs_review", "pending", false), REQ)).toBe("open");
    expect(actionRequiredReason(b("draft", "pending", true))).toMatch(/rejected/);
  });
});

describe("overrides: approved exception / manual removal (AC-10)", () => {
  const pending = { kind: "exception" as const, reason: "Paid by check, verified", requestedBy: "u1", status: "pending" as const };
  it("a pending request changes nothing; approval resolves/removes", () => {
    expect(run([{ batch: b("failed"), override: pending }])[0]).toBe("action_required");
    expect(run([{ batch: b("failed"), override: { ...pending, status: "approved", decidedBy: "u2" } }])[0]).toBe("resolved");
    expect(run([{ batch: b("processing"), override: { ...pending, kind: "removal", status: "approved" } }])[0]).toBe("removed");
    expect(run([{ batch: b("failed"), override: { ...pending, status: "rejected" } }])[0]).toBe("action_required");
  });
  it("approval without a reason never counts", () => {
    expect(buildEmergencyInputs({ override: { ...pending, reason: " ", status: "approved" } }, b("failed"), REQ).exceptionReason).toBe(" ");
    expect(run([{ batch: b("failed"), override: { ...pending, reason: " ", status: "approved" } }])[0]).toBe("action_required");
  });
});

describe("resolve endpoint pre-check (409 reasons)", () => {
  it("explains why an item cannot be resolved", () => {
    expect(resolutionCheck({}, null, REQ)).toMatchObject({ ok: false, reason: expect.stringMatching(/not completed/) });
    expect(resolutionCheck({}, b("processing"), REQ).ok).toBe(false);
    expect(resolutionCheck({}, b("processed", "pending"), REQ)).toMatchObject({ ok: false, reason: expect.stringMatching(/not reconciled/) });
    expect(resolutionCheck({}, b("processed", "mismatch"), REQ).reason).toMatch(/mismatch/);
  });
  it("the acting reviewer's confirmation counts, so processed + reconciled is resolvable", () => {
    expect(resolutionCheck({ reviewerConfirmed: false }, b("processed", "reconciled"), REQ).ok).toBe(true);
  });
});
