import { describe, expect, it } from "vitest";
import {
  decideReminder,
  escalationLevel,
  escalationRecipients,
  reminderKey,
  validateSnooze,
} from "@/lib/reminders/engine";

describe("AC-08: reminders send once, no bursts", () => {
  const due = "2026-12-31";
  it("fires each default offset on its day: 30,14,7,3,1,0", () => {
    const days: Record<string, number> = {
      "2026-12-01": 30,
      "2026-12-17": 14,
      "2026-12-24": 7,
      "2026-12-28": 3,
      "2026-12-30": 1,
      "2026-12-31": 0,
    };
    for (const [today, offset] of Object.entries(days)) {
      expect(decideReminder({ dueDate: due, today, alreadyHandled: new Set() }).send).toBe(offset);
    }
  });
  it("sends nothing on non-offset days", () => {
    expect(decideReminder({ dueDate: due, today: "2026-12-10", alreadyHandled: new Set([30]) }).send).toBe(null);
  });
  it("does not resend an offset that was already handled (retry/duplicate worker run)", () => {
    expect(decideReminder({ dueDate: due, today: "2026-12-01", alreadyHandled: new Set([30]) }).send).toBe(null);
  });
  it("task created late: sends ONE most-urgent reminder and skips the stale ones", () => {
    const d = decideReminder({ dueDate: due, today: "2026-12-26", alreadyHandled: new Set() });
    expect(d.send).toBe(7);
    expect(d.skipped).toEqual([30, 14]);
  });
  it("no pre-due reminder after the due date (escalation takes over)", () => {
    expect(decideReminder({ dueDate: due, today: "2027-01-02", alreadyHandled: new Set() }).send).toBe(null);
  });
  it("dedupe key is stable and includes candidate+task+due+channel+offset", () => {
    const a = reminderKey({ candidateId: "c1", taskType: "monthly_review", dueDate: due, channel: "email", offset: 7 });
    expect(a).toBe(reminderKey({ candidateId: "c1", taskType: "monthly_review", dueDate: due, channel: "email", offset: 7 }));
    expect(a).not.toBe(reminderKey({ candidateId: "c1", taskType: "monthly_review", dueDate: due, channel: "in_app", offset: 7 }));
    expect(a).not.toBe(reminderKey({ candidateId: "c1", taskType: "monthly_review", dueDate: due, channel: "email", offset: 3 }));
  });
});

describe("overdue escalation: owner → team lead (1bd) → compliance manager (3bd) → admin (5bd)", () => {
  // due Fri 2026-11-20
  it.each([
    ["2026-11-20", 0],
    ["2026-11-21", 0], // Saturday: no business day elapsed
    ["2026-11-23", 1], // Mon = 1 bd
    ["2026-11-25", 3], // Wed = 3 bd  -> level 2
    ["2026-11-27", 5],
  ])("on %s level is derived from business days", (today, bd) => {
    const level = escalationLevel("2026-11-20", today);
    expect(level).toBe(bd === 0 ? 0 : bd === 1 ? 1 : bd === 3 ? 2 : 3);
  });
  it("routes to the correct owner at each level", () => {
    const users = { ownerId: "owner", teamLeadId: "lead", complianceManagerIds: ["mgr"], adminIds: ["admin"] };
    expect(escalationRecipients(0, users).userIds).toEqual(["owner"]);
    expect(escalationRecipients(1, users).userIds).toEqual(["lead"]);
    expect(escalationRecipients(2, users).userIds).toEqual(["mgr"]);
    expect(escalationRecipients(3, users).userIds).toEqual(["admin"]);
  });
  it("falls upward when a level has nobody (never silently drops)", () => {
    const r = escalationRecipients(1, { ownerId: "owner", teamLeadId: null, complianceManagerIds: ["mgr"], adminIds: ["admin"] });
    expect(r).toEqual({ level: 2, userIds: ["mgr"] });
  });
});

describe("snooze", () => {
  it("needs a reason and a later date", () => {
    expect(validateSnooze({ reason: "", currentDueDate: "2026-12-01", newDueDate: "2026-12-05" }).ok).toBe(false);
    expect(validateSnooze({ reason: "Waiting on DSO", currentDueDate: "2026-12-01", newDueDate: "2026-12-01" }).ok).toBe(false);
    expect(validateSnooze({ reason: "Waiting on DSO", currentDueDate: "2026-12-01", newDueDate: "2026-12-05" }).ok).toBe(true);
  });
});
