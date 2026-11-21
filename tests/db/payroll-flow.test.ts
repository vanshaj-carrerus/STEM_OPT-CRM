import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, stopTestDb } from "../helpers/db";

/**
 * DB-backed payroll flows (run with RUN_DB_TESTS=1): AC-11 separation of duties, AC-13 duplicate webhooks,
 * AC-09/10 emergency lifecycle end-to-end. Services only read id/role/permissions from the actor, so plain
 * actor objects stand in for sessions.
 */
const SECRET = "gusto-webhook-secret-for-tests-1234";
process.env.GUSTO_WEBHOOK_SECRET = SECRET;

type Actor = import("@/lib/auth/session").SessionUser;
const actor = (id: string, role: Actor["role"]) => ({ id, role, email: `${id}@t.test`, name: id, timezone: "UTC", mustChangePassword: false, sessionId: "s", doc: {} }) as unknown as Actor;
const preparer = actor("prep-1", "payroll_preparer");
const approver = actor("appr-1", "payroll_approver");
const approver2 = actor("appr-2", "payroll_approver");
const manager = actor("mgr-1", "compliance_manager");
const admin = actor("adm-1", "super_admin");

describe("payroll flows (DB)", () => {
  beforeAll(async () => {
    await startTestDb();
    const { User } = await import("@/lib/db/models/user");
    for (const u of [preparer, approver, approver2, manager, admin]) {
      await User.create({ _id: u.id, name: u.name, email: u.email, passwordHash: "x", role: u.role, active: true });
    }
    const { Candidate } = await import("@/lib/db/models/candidate");
    await Candidate.create({
      _id: "cand-1", candidateCode: "CND-000001", legalName: "Asha Rao", email: "a@t.test", emailLower: "a@t.test", authType: "OPT", stage: "active",
      ownerId: "prep-1", teamMemberIds: [], tags: [], notes: [], contactHistory: [], riskFlags: [], i983Status: "not_applicable", priority: "normal",
      payrollMapping: { provider: "gusto", employeeId: "g-100" },
    });
  });
  afterAll(stopTestDb);

  async function newApprovableBatch(start: string) {
    const b = await import("@/lib/payroll/batches");
    const batch = await b.createBatch(preparer, { payPeriod: { start, end: start, payDate: start } });
    await b.saveItem(preparer, batch._id, { candidateId: "cand-1", hours: "10", payType: "hourly", gross: "100.00", net: "80.00" });
    await b.submitForReview(preparer, batch._id);
    return batch._id;
  }

  it("AC-11: preparer cannot approve; a different approver can; an edit after approval resets and the editor cannot re-approve", async () => {
    const b = await import("@/lib/payroll/batches");
    const { SeparationOfDutiesError } = await import("@/lib/sod");
    const id2 = await newApprovableBatch("2026-01-02");
    await expect(b.approveBatch(preparer, id2)).rejects.toThrow(/permission|prepared or edited/i);
    const approved = await b.approveBatch(approver, id2);
    expect(approved.status).toBe("approved");
    // edit after approval (by approver2 holding prepare via admin-like role is not needed: use preparer)
    await b.saveItem(preparer, id2, { candidateId: "cand-1", hours: "11", payType: "hourly", gross: "110.00", net: "88.00" });
    const after = await b.loadBatch(id2);
    expect(after.status).toBe("needs_review");
    expect(after.approvedBy).toBeNull();
    // a super admin who edits can never approve afterwards
    await b.saveItem(admin, id2, { candidateId: "cand-1", hours: "12", payType: "hourly", gross: "120.00", net: "96.00" });
    await expect(b.approveBatch(admin, id2)).rejects.toBeInstanceOf(SeparationOfDutiesError);
    expect((await b.approveBatch(approver2, id2)).status).toBe("approved");
  });

  it("processed payroll can only come from provider evidence/verified event, and is never voided", async () => {
    const b = await import("@/lib/payroll/batches");
    const id = await newApprovableBatch("2026-02-01");
    await b.approveBatch(approver, id);
    await expect(b.recordProviderEvidence(preparer, id, { processedDate: "2026-02-02", note: "Viewed in Gusto" })).rejects.toThrow(); // no reconcile/approve rights
    await expect(b.recordProviderEvidence(approver, id, { processedDate: "2026-02-02", note: "Viewed in Gusto" })).rejects.toThrow(/provider reference/i);
    const done = await b.recordProviderEvidence(approver, id, { externalRef: "gusto-pay-1", processedDate: "2026-02-02", note: "Viewed in Gusto" });
    expect(done.status).toBe("processed");
    expect(done.reconciliation.status).toBe("pending");
    await expect(b.voidBatch(preparer, id, "oops no")).rejects.toThrow(/never be voided/i);
    await expect(b.saveItem(preparer, id, { candidateId: "cand-1", hours: "1", payType: "hourly", gross: "1", net: "1" })).rejects.toThrow(/cannot be edited/i);
  });

  it("AC-13: a duplicate webhook delivery yields one record and one state change", async () => {
    const b = await import("@/lib/payroll/batches");
    const { handleGustoWebhook } = await import("@/lib/payroll/webhook-handler");
    const { signForTest } = await import("@/lib/integrations/events");
    const { IntegrationEvent } = await import("@/lib/db/models/integration-event");
    const { AuditEvent } = await import("@/lib/db/models/audit");
    const id = await newApprovableBatch("2026-03-01");
    await b.approveBatch(approver, id);
    await b.markSubmittedToProvider(preparer, id, { externalRef: "gusto-pay-2" });

    const body = JSON.stringify({ event_id: "evt-1", event_type: "payroll.processed", resource_uuid: "gusto-pay-2" });
    const headers = { signature: signForTest(SECRET, body, Math.floor(Date.now() / 1000)), timestamp: null };
    const first = await handleGustoWebhook(body, headers);
    expect(first).toMatchObject({ status: 200, body: { applied: true } });
    const before = await AuditEvent.countDocuments({ entityId: id, action: "status_change" });
    const dup = await handleGustoWebhook(body, headers);
    expect(dup).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(await IntegrationEvent.countDocuments({ provider: "gusto", eventId: "evt-1" })).toBe(1);
    expect(await AuditEvent.countDocuments({ entityId: id, action: "status_change" })).toBe(before);
    const batch = await b.loadBatch(id);
    expect(batch).toMatchObject({ status: "processed", processedVia: "webhook" });

    // forged / stale deliveries are rejected and change nothing
    expect((await handleGustoWebhook(body, { signature: "t=1,v1=" + "0".repeat(64), timestamp: null })).status).toBe(401);
    // a later contradictory event cannot un-process the batch
    const bad = JSON.stringify({ event_id: "evt-2", event_type: "payroll.cancelled", resource_uuid: "gusto-pay-2" });
    const res = await handleGustoWebhook(bad, { signature: signForTest(SECRET, bad, Math.floor(Date.now() / 1000)), timestamp: null });
    expect(res.status).toBe(200);
    expect((await b.loadBatch(id)).status).toBe("processed");
  });

  it("AC-09/10: emergency item stays active until processed + reconciled + reviewer; mismatch makes it Action Required", async () => {
    const b = await import("@/lib/payroll/batches");
    const e = await import("@/lib/payroll/emergency");
    const { Task } = await import("@/lib/db/models/task");
    const item = await e.flagEmergency(preparer, { candidateId: "cand-1", reason: "Missed payroll, urgent", requestedPayDate: "2026-04-05", ownerId: "prep-1" });
    await expect(e.flagEmergency(preparer, { candidateId: "cand-1", reason: "Duplicate flag", requestedPayDate: "2026-04-05" })).rejects.toThrow(/already has an active/);

    const id = await newApprovableBatch("2026-04-01"); // saveItem links the candidate's active emergency item
    expect((await e.syncEmergencyItem(item._id))!.batchId).toBe(id);
    await expect(e.resolveEmergency(approver, item._id)).rejects.toMatchObject({ status: 409, code: "not_resolvable" });
    await b.approveBatch(approver, id);
    await b.markSubmittedToProvider(preparer, id, { externalRef: "gusto-pay-3" });
    const { EmergencyPayrollItem } = await import("@/lib/db/models/emergency-payroll-item");
    expect((await EmergencyPayrollItem.findById(item._id).lean())!.status).toBe("processing");

    await b.recordProviderEvidence(approver, id, { externalRef: "gusto-pay-3", processedDate: "2026-04-02", note: "Viewed in Gusto" });
    let cur = (await EmergencyPayrollItem.findById(item._id).lean())!;
    expect(cur.status).toBe("pending_reconciliation");
    expect(cur.isActive).toBe(true);
    await expect(e.resolveEmergency(approver, item._id)).rejects.toMatchObject({ status: 409 });

    // mismatch → Action Required + owner task
    await b.reconcileBatch(approver, id, { providerTotal: "81.00", settlementTotal: "81.00", settlementReference: "ACH-9" });
    cur = (await EmergencyPayrollItem.findById(item._id).lean())!;
    expect(cur.status).toBe("action_required");
    expect(await Task.countDocuments({ refKey: `payroll:emergency:${item._id}:action`, status: "open" })).toBe(1);

    // matching reconciliation → back to pending, then reviewer resolves
    await b.reconcileBatch(approver, id, { providerTotal: "80.00", settlementTotal: "80.00", settlementReference: "ACH-9" });
    expect((await EmergencyPayrollItem.findById(item._id).lean())!.status).toBe("pending_reconciliation");
    const resolved = await e.resolveEmergency(approver, item._id, { note: "Settlement matches" });
    expect(resolved.status).toBe("resolved");
    expect(resolved.isActive).toBe(false);
    expect(resolved.history.length).toBeGreaterThan(3); // history preserved
    // the candidate can be flagged again afterwards
    await expect(e.flagEmergency(preparer, { candidateId: "cand-1", reason: "Second emergency", requestedPayDate: "2026-05-01" })).resolves.toBeDefined();
  });

  it("AC-10: manual removal needs a different manager and a reason", async () => {
    const e = await import("@/lib/payroll/emergency");
    const { EmergencyPayrollItem } = await import("@/lib/db/models/emergency-payroll-item");
    const active = (await EmergencyPayrollItem.findOne({ candidateId: "cand-1", isActive: true }).lean())!;
    await expect(e.requestOverride(manager, active._id, { kind: "removal", reason: "x" })).rejects.toThrow();
    await e.requestOverride(manager, active._id, { kind: "removal", reason: "Duplicate request entered in error" });
    await expect(e.decideOverride(manager, active._id, { decision: "approve" })).rejects.toThrow(/different manager/i); // requester ≠ approver
    const done = await e.decideOverride(admin, active._id, { decision: "approve" });
    expect(done.status).toBe("removed");
    expect(done.isActive).toBe(false);
  });
});
