import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCollections, startTestDb, stopTestDb } from "../helpers/db";
import type { SessionUser } from "@/lib/auth/session";

/** Needs a reachable MongoDB replica set: RUN_DB_TESTS=1 npm test */
const SECRET = "ria-test-webhook-secret-0123456789";
let docsDir: string;

beforeAll(async () => {
  docsDir = mkdtempSync(join(tmpdir(), "crm-pay-"));
  process.env.DOCS_DIR = docsDir;
  process.env.RIA_WEBHOOK_SECRET = SECRET;
  await startTestDb();
});
afterAll(async () => {
  await stopTestDb();
  rmSync(docsDir, { recursive: true, force: true });
});
beforeEach(clearCollections);

async function actor(role: "finance_operator" | "finance_approver" | "super_admin", id: string): Promise<SessionUser> {
  return { id, role, email: `${id}@x.test`, name: id, timezone: "UTC", mustChangePassword: false, sessionId: "s", doc: {} } as unknown as SessionUser;
}

let seq = 0;
async function seedCandidate() {
  const { Candidate } = await import("@/lib/db/models/candidate");
  const n = ++seq;
  const c = await Candidate.create({ candidateCode: `CND-T${n}`, legalName: "Test Candidate", email: `t${n}@x.test`, emailLower: `t${n}@x.test` });
  return c._id as string;
}

const input = (candidateId: string, over: Record<string, unknown> = {}) => ({
  candidateId, type: "ria_transfer" as const, amount: "100.00", currency: "USD", reason: "Payroll remittance",
  recipientName: "Rec Name", recipientDestination: "****1234", ...over,
});

/** A candidate's first payment has a NEW recipient, which is high-risk → two distinct approvers. */
async function approveFully(id: string) {
  const svc = await import("@/lib/payments/service");
  await svc.approvePayment(await actor("finance_approver", "ap1"), id);
  await svc.approvePayment(await actor("finance_approver", "ap2"), id);
}

async function approvedPayment(opts: { amount?: string; highRisk?: boolean } = {}) {
  const { paymentInputSchema } = await import("@/lib/payments/schema");
  const svc = await import("@/lib/payments/service");
  const cid = await seedCandidate();
  const op = await actor("finance_operator", "op1");
  const { payment } = await svc.createPayment(op, paymentInputSchema.parse(input(cid, { amount: opts.amount ?? "100.00" })));
  await svc.submitForApproval(op, payment._id);
  return { id: payment._id, cid, op };
}

describe("approval SoD and dual control", () => {
  it("requester can never approve; high-risk needs two distinct approvers", async () => {
    const svc = await import("@/lib/payments/service");
    const { Payment } = await import("@/lib/db/models/payment");
    const { id, op } = await approvedPayment({ amount: "9000.00" }); // above threshold → high-risk
    const p = await Payment.findById(id).lean<{ highRisk: boolean; requiredApprovals: number }>();
    expect(p!.highRisk).toBe(true);
    expect(p!.requiredApprovals).toBe(2);

    const approver1 = await actor("finance_approver", "ap1");
    const approver2 = await actor("finance_approver", "ap2");
    const admin = await actor("super_admin", "op1"); // same user id as requester but with approve rights
    await expect(svc.approvePayment(admin, id)).rejects.toThrow(/cannot approve/);
    expect(op.id).toBe("op1");

    const r1 = await svc.approvePayment(approver1, id);
    expect(r1.finalized).toBe(false);
    await expect(svc.approvePayment(approver1, id)).rejects.toThrow();
    const r2 = await svc.approvePayment(approver2, id);
    expect(r2.finalized).toBe(true);
    expect((await Payment.findById(id).lean<{ status: string }>())!.status).toBe("approved");
  });

  it("high-risk reconciler must differ from requester and approvers", async () => {
    const svc = await import("@/lib/payments/service");
    const ex = await import("@/lib/payments/execution");
    const { PaymentReceipt } = await import("@/lib/db/models/payment-receipt");
    const { id, cid } = await approvedPayment({ amount: "9000.00" });
    const [a1, a2, other] = await Promise.all([actor("finance_approver", "ap1"), actor("finance_approver", "ap2"), actor("finance_approver", "ap3")]);
    await svc.approvePayment(a1, id);
    await svc.approvePayment(a2, id);
    const op = await actor("finance_operator", "op1");
    await ex.recordSubmission(op, id, { providerReference: "RIA-TEST-0001" });
    await PaymentReceipt.create({ paymentId: id, candidateId: cid, kind: "receipt", objectKey: "x/y", fileName: "r.pdf", contentType: "application/pdf", sizeBytes: 1, sha256: "a".repeat(64), uploadedBy: "op1" });
    await ex.markPaid(op, id);
    const rec = { statementRef: "STMT-1", settledAmount: "9000.00" };
    await expect(ex.reconcilePayment(a1, id, rec)).rejects.toThrow(/reconciler/);
    const done = await ex.reconcilePayment(other, id, rec);
    expect(done.status).toBe("reconciled");
  });

  it("paid is refused without a reference and evidence", async () => {
    const svc = await import("@/lib/payments/service");
    const ex = await import("@/lib/payments/execution");
    const { id } = await approvedPayment();
    await approveFully(id);
    const op = await actor("finance_operator", "op1");
    await expect(ex.markPaid(op, id)).rejects.toThrow(); // still Approved: illegal transition
    await ex.recordSubmission(op, id, { providerReference: "RIA-TEST-0002" });
    await expect(ex.markPaid(op, id)).rejects.toThrow(/receipt|evidence/i);
  });
});

describe("immutable ledger", () => {
  it("money fields are frozen after Draft and rows can never be deleted", async () => {
    const { Payment } = await import("@/lib/db/models/payment");
    const { id } = await approvedPayment(); // awaiting_approval
    await expect(Payment.updateOne({ _id: id }, { $set: { amountMinor: 1 } })).rejects.toThrow(/frozen/);
    await expect(Payment.updateOne({ _id: id, status: "awaiting_approval" }, { $set: { amountMinor: 1 } })).rejects.toThrow(/frozen/);
    await expect(Payment.deleteOne({ _id: id })).rejects.toThrow(/never deleted/);
    expect((await Payment.findById(id).lean<{ amountMinor: number }>())!.amountMinor).toBe(10000);
  });

  it("payment_events are append-only", async () => {
    const { PaymentEvent } = await import("@/lib/db/models/payment-event");
    const { id } = await approvedPayment();
    const ev = await PaymentEvent.findOne({ paymentId: id });
    await expect(PaymentEvent.updateOne({ _id: ev!._id }, { $set: { reason: "x" } })).rejects.toThrow(/append-only/);
    await expect(PaymentEvent.deleteMany({ paymentId: id })).rejects.toThrow(/append-only/);
  });

  it("the same provider reference cannot be recorded on two payments", async () => {
    const svc = await import("@/lib/payments/service");
    const ex = await import("@/lib/payments/execution");
    const a = await approvedPayment();
    const b = await approvedPayment();
    await approveFully(a.id);
    await approveFully(b.id);
    await ex.recordSubmission(a.op, a.id, { providerReference: "RIA-DUP-0001" });
    await expect(ex.recordSubmission(b.op, b.id, { providerReference: "RIA-DUP-0001" })).rejects.toThrow(/already recorded/);
  });

  it("client Idempotency-Key replays return the same draft", async () => {
    const { paymentInputSchema } = await import("@/lib/payments/schema");
    const svc = await import("@/lib/payments/service");
    const { Payment } = await import("@/lib/db/models/payment");
    const cid = await seedCandidate();
    const op = await actor("finance_operator", "op1");
    const a = await svc.createPayment(op, paymentInputSchema.parse(input(cid)), { requestKey: "k1" });
    const b = await svc.createPayment(op, paymentInputSchema.parse(input(cid)), { requestKey: "k1" });
    expect(b.replay).toBe(true);
    expect(b.payment._id).toBe(a.payment._id);
    expect(await Payment.countDocuments()).toBe(1);
  });
});

describe("AC-13: Ria webhook idempotency", () => {
  async function submittedPayment() {
    const svc = await import("@/lib/payments/service");
    const ex = await import("@/lib/payments/execution");
    const { id, op } = await approvedPayment();
    await approveFully(id);
    await ex.recordSubmission(op, id, { providerReference: "RIA-HOOK-0001" });
    return id;
  }
  async function post(body: unknown, secret = SECRET) {
    const { handlePaymentWebhook } = await import("@/lib/integrations/payment-webhook");
    const { signForTest } = await import("@/lib/integrations/events");
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    return handlePaymentWebhook(new Request("http://x/api/integrations/ria/webhook", { method: "POST", body: raw, headers: { "x-signature": signForTest(secret, raw, ts) } }), "ria");
  }
  const enableRia = async () => {
    const { setSetting } = await import("@/lib/settings");
    await setSetting("integrations.ria", { contractApproved: true, apiConfigured: true }, null);
  };

  it("is ignored with 202 while automation is disabled", async () => {
    const id = await submittedPayment();
    const res = await post({ eventId: "evt-0001", transferId: "RIA-HOOK-0001", status: "paid" });
    expect(res.status).toBe(202);
    const { Payment } = await import("@/lib/db/models/payment");
    expect((await Payment.findById(id).lean<{ status: string }>())!.status).toBe("submitted");
  });

  it("rejects a bad signature", async () => {
    await submittedPayment();
    await enableRia();
    expect((await post({ eventId: "evt-0002", transferId: "RIA-HOOK-0001", status: "paid" }, "wrong-secret-wrong-secret")).status).toBe(401);
  });

  it("a duplicate / retried callback creates one record and one transition", async () => {
    const id = await submittedPayment();
    await enableRia();
    const body = { eventId: "evt-0003", idempotencyKey: id, transferId: "RIA-HOOK-0001", status: "processing" };
    expect((await post(body)).status).toBe(200);
    const second = await post(body);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status: string }).status).toBe("duplicate");
    const { IntegrationEvent } = await import("@/lib/db/models/integration-event");
    const { PaymentEvent } = await import("@/lib/db/models/payment-event");
    expect(await IntegrationEvent.countDocuments({ provider: "ria", eventId: "evt-0003" })).toBe(1);
    expect(await PaymentEvent.countDocuments({ paymentId: id, toStatus: "processing" })).toBe(1);
  });

  it("illegal transitions are held for review, not applied", async () => {
    const id = await submittedPayment();
    await enableRia();
    expect((await post({ eventId: "evt-0004", transferId: "RIA-HOOK-0001", status: "paid" })).status).toBe(200); // evidence stored from callback
    const { Payment } = await import("@/lib/db/models/payment");
    expect((await Payment.findById(id).lean<{ status: string }>())!.status).toBe("paid");
    await post({ eventId: "evt-0005", transferId: "RIA-HOOK-0001", status: "processing" }); // late, out of order
    expect((await Payment.findById(id).lean<{ status: string }>())!.status).toBe("paid");
  });
});
