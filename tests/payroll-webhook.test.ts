import { describe, expect, it } from "vitest";
import { decideDelivery, mapEventTypeToStatus, parseGustoWebhook, planWebhookTransitions, STALE_RECEIVED_MS } from "@/lib/payroll/webhook-map";
import { signForTest, verifySignature } from "@/lib/integrations/events";
import { canTransitionPayroll, PAYROLL_STATUSES } from "@/lib/payroll/rules";

describe("Gusto webhook payload parsing", () => {
  it("accepts several field spellings", () => {
    const r = parseGustoWebhook({ event_id: "e1", event_type: "payroll.processed", resource_uuid: "p-9", timestamp: 1_700_000_000 });
    expect(r.ok && r.event).toMatchObject({ eventId: "e1", externalRef: "p-9", target: "processed" });
    const r2 = parseGustoWebhook({ uuid: "e2", type: "payroll.submitted", data: { payroll_uuid: "p-1" } });
    expect(r2.ok && r2.event.target).toBe("processing");
  });
  it("rejects missing or malformed ids", () => {
    expect(parseGustoWebhook(null).ok).toBe(false);
    expect(parseGustoWebhook({ event_type: "x", resource_uuid: "p" }).ok).toBe(false);
    expect(parseGustoWebhook({ event_id: "e", event_type: "x" }).ok).toBe(false);
    expect(parseGustoWebhook({ event_id: "e e", event_type: "x", resource_uuid: "p" }).ok).toBe(false);
  });
  it("maps event types to CRM statuses (unknown → null)", () => {
    expect(mapEventTypeToStatus("payroll.failed")).toBe("failed");
    expect(mapEventTypeToStatus("payroll.cancelled")).toBe("voided");
    expect(mapEventTypeToStatus("payroll.paid")).toBe("processed");
    expect(mapEventTypeToStatus("employee.updated")).toBeNull();
  });
});

describe("webhook → transition decision applies only what canTransitionPayroll allows", () => {
  it("never produces an illegal transition for any status/target pair", () => {
    for (const cur of PAYROLL_STATUSES) {
      for (const tgt of PAYROLL_STATUSES) {
        const plan = planWebhookTransitions(cur, tgt);
        if (plan.action !== "apply") continue;
        let from = cur;
        for (const step of plan.steps) {
          expect(canTransitionPayroll(from, step)).toBe(true);
          from = step;
        }
        expect(from).toBe(tgt);
      }
    }
  });
  it("approved + processed is applied as processing → processed; unapproved batches are rejected, not applied", () => {
    expect(planWebhookTransitions("approved", "processed")).toEqual({ action: "apply", steps: ["processing", "processed"] });
    expect(planWebhookTransitions("processing", "processed")).toEqual({ action: "apply", steps: ["processed"] });
    expect(planWebhookTransitions("draft", "processed").action).toBe("reject");
    expect(planWebhookTransitions("needs_review", "processing").action).toBe("reject");
  });
  it("is a no-op for same state / unmapped event, and processed/voided are immutable", () => {
    expect(planWebhookTransitions("processed", "processed").action).toBe("noop");
    expect(planWebhookTransitions("processing", null).action).toBe("noop");
    expect(planWebhookTransitions("processed", "voided").action).toBe("reject");
    expect(planWebhookTransitions("voided", "processing").action).toBe("reject");
  });
});

describe("AC-13: duplicate delivery decision", () => {
  it("processes new events, retries failed/abandoned ones, ignores everything else", () => {
    expect(decideDelivery(true, "received")).toBe("process");
    expect(decideDelivery(false, "processed")).toBe("ignore");
    expect(decideDelivery(false, "received", 1000)).toBe("ignore"); // concurrent in-flight duplicate
    expect(decideDelivery(false, "received", STALE_RECEIVED_MS + 1)).toBe("retry"); // crashed worker
    expect(decideDelivery(false, "failed")).toBe("retry");
    expect(decideDelivery(false, "duplicate_ignored")).toBe("ignore");
  });
});

describe("webhook signature + replay window", () => {
  const secret = "gusto-secret-gusto-secret-123456";
  const body = JSON.stringify({ event_id: "e1" });
  const now = 1_700_000_000;
  it("accepts a valid signature and rejects tampering, bad secrets and stale timestamps", () => {
    const sig = signForTest(secret, body, now);
    expect(verifySignature({ secret, rawBody: body, signatureHeader: sig, now }).ok).toBe(true);
    expect(verifySignature({ secret, rawBody: body + " ", signatureHeader: sig, now }).ok).toBe(false);
    expect(verifySignature({ secret: "other-secret-other-secret-1234", rawBody: body, signatureHeader: sig, now }).ok).toBe(false);
    expect(verifySignature({ secret, rawBody: body, signatureHeader: sig, now: now + 3600 }).reason).toMatch(/replay/i);
    expect(verifySignature({ secret: "", rawBody: body, signatureHeader: sig, now }).ok).toBe(false);
    expect(verifySignature({ secret, rawBody: body, signatureHeader: null, now }).ok).toBe(false);
  });
});
