import { describe, expect, it } from "vitest";
import { approvalProgress, frozenViolations, isMoneyEditable } from "@/lib/payments/approvals";
import { adjustmentTotal, netAmountMinor, validateLinkedEvent } from "@/lib/payments/linked";
import { assessRisk, classifyRecipient, usdMinorOf } from "@/lib/payments/risk";
import { decideWebhookTransition, mapProviderStatus, providerEventSchema } from "@/lib/payments/webhook-decision";
import { evidenceSatisfied } from "@/lib/payments/evidence";
import { buildLedgerCsv } from "@/lib/payments/ledger-csv";
import { availableCommands } from "@/lib/payments/commands";
import { settledTotalsMinor } from "@/lib/payments/queries-pure";
import { PAYMENT_STATUSES, type PaymentStatus } from "@/lib/payments/rules";
import type { PaymentView } from "@/lib/payments/view";
import type { Actor } from "@/lib/rbac/can";

describe("approval progress", () => {
  it("one approval clears a standard payment", () => {
    const p = approvalProgress({ required: 1, excludedIds: ["req"], approvals: [{ approverId: "a1", decision: "approve" }] });
    expect(p.satisfied).toBe(true);
  });
  it("high-risk needs two DISTINCT approvers; duplicates ignored", () => {
    const one = approvalProgress({ required: 2, excludedIds: ["req"], approvals: [{ approverId: "a1", decision: "approve" }, { approverId: "a1", decision: "approve" }] });
    expect(one.satisfied).toBe(false);
    expect(one.count).toBe(1);
    expect(one.remaining).toBe(1);
    expect(one.ignored).toEqual([{ approverId: "a1", reason: "duplicate" }]);
    const two = approvalProgress({ required: 2, excludedIds: ["req"], approvals: [{ approverId: "a1", decision: "approve" }, { approverId: "a2", decision: "approve" }] });
    expect(two.satisfied).toBe(true);
  });
  it("the requester (or creator) never counts", () => {
    const p = approvalProgress({ required: 2, excludedIds: ["req", "creator"], approvals: [{ approverId: "req", decision: "approve" }, { approverId: "creator", decision: "approve" }, { approverId: "a1", decision: "approve" }] });
    expect(p.count).toBe(1);
    expect(p.satisfied).toBe(false);
    expect(p.ignored.map((i) => i.reason)).toEqual(["excluded", "excluded"]);
  });
  it("any rejection stops the round", () => {
    const p = approvalProgress({ required: 1, excludedIds: [], approvals: [{ approverId: "a1", decision: "approve" }, { approverId: "a2", decision: "reject" }] });
    expect(p.rejected).toBe(true);
    expect(p.satisfied).toBe(false);
  });
});

describe("money fields freeze once a payment leaves Draft", () => {
  it("only Draft is editable", () => {
    for (const s of PAYMENT_STATUSES) expect(isMoneyEditable(s)).toBe(s === "draft");
  });
  it("flags every frozen field a change would touch", () => {
    expect(frozenViolations("draft", ["amountMinor", "currency"])).toEqual([]);
    expect(frozenViolations("approved", ["amountMinor", "recipientDestination", "providerReference"])).toEqual(["amountMinor", "recipientDestination"]);
    expect(frozenViolations("awaiting_approval", ["feeMinor"])).toEqual(["feeMinor"]);
    expect(frozenViolations("paid", ["status", "reconciledBy"])).toEqual([]); // control fields remain writable
  });
});

describe("linked events: partial → return → correction", () => {
  it("nets signed deltas against the original amount", () => {
    const events = [
      { kind: "partial", amountDeltaMinor: -40000 }, // 400.00 not delivered
      { kind: "return", amountDeltaMinor: -10000 }, // 100.00 returned
      { kind: "correction", amountDeltaMinor: 2500 }, // +25.00 fix
      { kind: "receipt", amountDeltaMinor: 0 },
      { kind: "status_change", amountDeltaMinor: -999 }, // not a money event: ignored
    ];
    expect(adjustmentTotal(events)).toBe(-47500);
    expect(netAmountMinor(100000, events)).toBe(52500);
  });
  it("validates each step against the CURRENT net", () => {
    expect(validateLinkedEvent("partial", 100000, 40000)).toEqual({ ok: true, deltaMinor: -40000 });
    expect(validateLinkedEvent("return", 60000, 10000)).toEqual({ ok: true, deltaMinor: -10000 });
    expect(validateLinkedEvent("return", 60000, 60000).ok).toBe(false); // full return = Reverse
    expect(validateLinkedEvent("partial", 60000, 70000).ok).toBe(false);
    expect(validateLinkedEvent("return", 60000, -1).ok).toBe(false);
    expect(validateLinkedEvent("correction", 50000, -2500)).toEqual({ ok: true, deltaMinor: -2500 });
    expect(validateLinkedEvent("correction", 50000, -50000).ok).toBe(false);
    expect(validateLinkedEvent("correction", 50000, 0).ok).toBe(false);
  });
});

describe("risk assessment", () => {
  it("explains why a payment is high-risk and needs two approvals", () => {
    const small = assessRisk({ type: "ria_transfer", currency: "USD", amountMinor: 20000 });
    expect(small).toMatchObject({ highRisk: false, requiredApprovals: 1, reasons: [] });
    const big = assessRisk({ type: "domestic_wire", currency: "USD", amountMinor: 600000 });
    expect(big.highRisk).toBe(true);
    expect(big.requiredApprovals).toBe(2);
    expect(assessRisk({ type: "domestic_wire", currency: "USD", amountMinor: 600000, thresholdUsd: 10000 }).highRisk).toBe(false);
    expect(assessRisk({ type: "international_wire", currency: "USD", amountMinor: 100 }).highRisk).toBe(true);
    expect(assessRisk({ type: "ria_transfer", currency: "USD", amountMinor: 100, newRecipient: true }).reasons.join()).toMatch(/New recipient/);
    expect(assessRisk({ type: "ria_transfer", currency: "USD", amountMinor: 100, recipientChanged: true }).highRisk).toBe(true);
  });
  it("unknown USD value fails safe (high-risk)", () => {
    expect(usdMinorOf({ currency: "INR", amountMinor: 1000 })).toBeNull();
    expect(assessRisk({ type: "ria_transfer", currency: "INR", amountMinor: 1000 }).highRisk).toBe(true);
    expect(assessRisk({ type: "ria_transfer", currency: "INR", amountMinor: 1000, convertedCurrency: "USD", convertedAmountMinor: 1200 }).highRisk).toBe(false);
  });
  it("payroll settlements ignore recipient novelty", () => {
    expect(assessRisk({ type: "payroll_settlement", currency: "USD", amountMinor: 1000, newRecipient: true }).highRisk).toBe(false);
  });
  it("detects new / changed recipients against prior money-moved payments", () => {
    expect(classifyRecipient("fp1", [])).toEqual({ newRecipient: true, recipientChanged: false });
    expect(classifyRecipient("fp1", ["fp1"])).toEqual({ newRecipient: false, recipientChanged: false });
    expect(classifyRecipient("fp2", ["fp1"])).toEqual({ newRecipient: false, recipientChanged: true });
    expect(classifyRecipient("fp1", ["fp1", "fp2"]).recipientChanged).toBe(true); // differs from the LATEST
    expect(classifyRecipient(null, ["fp1"])).toEqual({ newRecipient: false, recipientChanged: false });
  });
});

describe("AC-13: provider event → transition decision", () => {
  const dec = (cur: PaymentStatus, raw: string, ref = true) => decideWebhookTransition(cur, raw, { hasProviderReference: ref });
  it("maps provider vocabularies", () => {
    expect(mapProviderStatus("COMPLETED")).toBe("paid");
    expect(mapProviderStatus("In Progress")).toBe("processing");
    expect(mapProviderStatus("returned")).toBe("reversed");
    expect(mapProviderStatus("weird")).toBeNull();
  });
  it("applies only transitions the state machine allows", () => {
    expect(dec("submitted", "processing")).toEqual({ action: "apply", to: "processing" });
    expect(dec("processing", "paid")).toEqual({ action: "apply", to: "paid" });
    expect(dec("processing", "failed")).toEqual({ action: "apply", to: "failed" });
    expect(dec("paid", "returned")).toEqual({ action: "apply", to: "reversed" });
  });
  it("illegal / out-of-order transitions are ignored, never forced", () => {
    expect(dec("approved", "paid").action).toBe("ignore"); // not submitted yet
    expect(dec("draft", "processing").action).toBe("ignore");
    expect(dec("paid", "processing").action).toBe("ignore"); // late, out-of-order
    expect(dec("cancelled", "paid").action).toBe("ignore");
    expect(dec("reversed", "paid").action).toBe("ignore");
    expect(dec("failed", "paid").action).toBe("ignore");
  });
  it("duplicate state is a harmless no-op", () => {
    expect(dec("paid", "paid").action).toBe("noop");
    expect(dec("processing", "pending").action).toBe("noop");
  });
  it("a callback can never approve, submit or reconcile; unknown statuses ignored; Paid needs a reference", () => {
    expect(dec("awaiting_approval", "approved").action).toBe("ignore");
    expect(dec("paid", "reconciled").action).toBe("ignore");
    expect(dec("submitted", "bogus").action).toBe("ignore");
    expect(dec("processing", "paid", false).action).toBe("ignore");
  });
  it("event contract requires an id and a status", () => {
    expect(providerEventSchema.safeParse({ eventId: "evt_12345", status: "paid", transferId: "RIA-1234" }).success).toBe(true);
    expect(providerEventSchema.safeParse({ status: "paid" }).success).toBe(false);
  });
});

describe("evidence required before Paid", () => {
  it("wires need a bank confirmation; Ria accepts a receipt", () => {
    expect(evidenceSatisfied("domestic_wire", ["receipt"])).toBe(false);
    expect(evidenceSatisfied("domestic_wire", ["bank_confirmation"])).toBe(true);
    expect(evidenceSatisfied("international_wire", ["provider_callback"])).toBe(true);
    expect(evidenceSatisfied("ria_transfer", [])).toBe(false);
    expect(evidenceSatisfied("ria_transfer", ["receipt"])).toBe(true);
    expect(evidenceSatisfied("ria_transfer", ["other"])).toBe(false);
  });
});

function view(over: Partial<PaymentView> = {}): PaymentView {
  return {
    id: "p1", candidateId: "c1", candidateCode: "CND-000001", candidateName: "Ada =Lovelace", type: "ria_transfer", status: "paid",
    amountMinor: 100000, currency: "USD", feeMinor: 500, fxRate: null, fxQuotedAt: null, convertedAmountMinor: null, convertedCurrency: null,
    amountUsdMinor: 100000, adjustmentMinor: 0, netMinor: 100000, reason: "Payroll", payPeriodStart: null, payPeriodEnd: null, invoiceRef: null,
    recipientName: "Rec Name", recipientDestination: "****4821", providerName: "ria", providerReference: "RIA-1", highRisk: false, riskReasons: [],
    requiredApprovals: 1, approvalRound: 1, newRecipient: false, recipientChanged: false, beneficiaryMismatch: false, beneficiaryMismatchNote: null,
    flags: ["Paid but not yet reconciled"], needsAttention: true, createdBy: "u1", requestedBy: "u1", approvedBy: ["a1"], approvedByNames: ["Approver"],
    submittedBy: null, reconciledBy: null, createdAt: "2026-11-01T00:00:00.000Z", requestedAt: null, approvedAt: null, submittedAt: null, paidAt: null,
    paidVia: null, failedAt: null, cancelledAt: null, reversedAt: null, reconciledAt: null, exceptionReason: null, reconciliation: null, linkedPaymentId: null, retryOf: null,
    ...over,
  };
}

describe("ledger CSV", () => {
  it("omits the destination column without payments.destination.view", () => {
    const csv = buildLedgerCsv([view()], { includeDestination: false });
    expect(csv).not.toMatch(/Masked destination/);
    expect(csv).not.toMatch(/4821/);
    expect(buildLedgerCsv([view()], { includeDestination: true })).toMatch(/\*\*\*\*4821/);
  });
  it("uses exact decimals and neutralises formula injection", () => {
    const row = buildLedgerCsv([view()], { includeDestination: false }).split("\r\n")[1];
    expect(row).toContain("1000.00");
    expect(row).toContain("5.00");
    expect(buildLedgerCsv([view({ candidateName: "=HYPERLINK(1)" })], { includeDestination: false })).toContain("'=HYPERLINK(1)");
  });
  it("field-stripped views (destination removed) export cleanly", () => {
    const stripped = view();
    delete (stripped as Partial<PaymentView>).recipientDestination;
    expect(() => buildLedgerCsv([stripped], { includeDestination: true })).not.toThrow();
  });
});

describe("candidate totals: payroll vs remittance never mixed", () => {
  it("buckets per currency using net-after-adjustments, paid/reconciled only", () => {
    const t = settledTotalsMinor([
      { type: "payroll_settlement", status: "reconciled", amountMinor: 100000, adjustmentMinor: 0, currency: "USD" },
      { type: "ria_transfer", status: "paid", amountMinor: 50000, adjustmentMinor: -10000, currency: "USD" },
      { type: "domestic_wire", status: "reconciled", amountMinor: 25050, adjustmentMinor: 0, currency: "USD" },
      { type: "ria_transfer", status: "failed", amountMinor: 99999, adjustmentMinor: 0, currency: "USD" },
      { type: "ria_transfer", status: "paid", amountMinor: 500, adjustmentMinor: 0, currency: "JPY" },
    ]);
    expect(t.payroll).toEqual({ USD: 100000 });
    expect(t.remittance).toEqual({ USD: 65050, JPY: 500 });
  });
});

describe("offered commands respect separation of duties", () => {
  const approver: Actor = { id: "a1", role: "finance_approver" };
  const operator: Actor = { id: "u1", role: "finance_operator" };
  it("requester is never offered Approve/Reject on their own request", () => {
    const awaiting = view({ status: "awaiting_approval", createdBy: "u1", requestedBy: "u1", approvedBy: [] });
    expect(availableCommands(approver, awaiting, { decidedByMe: false }).map((c) => c.command)).toEqual(expect.arrayContaining(["approve", "reject"]));
    const own = view({ status: "awaiting_approval", createdBy: "a1", requestedBy: "a1", approvedBy: [] });
    expect(availableCommands(approver, own, { decidedByMe: false }).map((c) => c.command)).not.toContain("approve");
    expect(availableCommands(approver, awaiting, { decidedByMe: true }).map((c) => c.command)).not.toContain("approve");
  });
  it("high-risk: the requester/approvers are not offered Reconcile", () => {
    const hr = view({ status: "paid", highRisk: true, createdBy: "u1", requestedBy: "u1", approvedBy: ["a1", "a2"] });
    expect(availableCommands(approver, hr, { decidedByMe: false }).map((c) => c.command)).not.toContain("reconcile");
    expect(availableCommands({ id: "f9", role: "finance_approver" }, hr, { decidedByMe: false }).map((c) => c.command)).toContain("reconcile");
  });
  it("operators can record submission but never approve or reconcile", () => {
    const approved = view({ status: "approved" });
    const cmds = availableCommands(operator, approved, { decidedByMe: false }).map((c) => c.command);
    expect(cmds).toContain("record_submission");
    expect(cmds).not.toContain("approve");
    expect(availableCommands(operator, view({ status: "paid" }), { decidedByMe: false }).map((c) => c.command)).not.toContain("reconcile");
  });
});
