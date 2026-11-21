import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearCollections, startTestDb, stopTestDb } from "../helpers/db";

describe("reminder dedupe is enforced by the database (AC-08)", () => {
  beforeAll(startTestDb);
  afterAll(stopTestDb);
  beforeEach(clearCollections);

  const doc = (over: Record<string, unknown> = {}) => ({
    key: "c1|milestone:x|2026-12-31|in_app|7|staff", candidateId: "c1", taskId: "t1", taskType: "milestone:x", dueDate: "2026-12-31",
    channel: "in_app", audience: "staff", offset: "7", templateKey: "staff.reminder", recipientIds: ["u1"],
    payload: { subject: "s", title: "t", body: "b", link: "/x" }, ...over,
  });

  it("parallel inserts of the same key: exactly one wins", async () => {
    const { Reminder } = await import("@/lib/db/models/reminder");
    await Reminder.init();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => Reminder.create(doc() as never)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === 11000)).toBe(true);
    expect(await Reminder.countDocuments()).toBe(1);
  });

  it("a different channel / offset / audience is a different key", async () => {
    const { Reminder } = await import("@/lib/db/models/reminder");
    await Reminder.init();
    await Reminder.create(doc() as never);
    await Reminder.create(doc({ key: "c1|milestone:x|2026-12-31|email|7|staff", channel: "email" }) as never);
    await Reminder.create(doc({ key: "c1|milestone:x|2026-12-31|email|7|candidate", channel: "email", audience: "candidate" }) as never);
    expect(await Reminder.countDocuments()).toBe(3);
  });

  it("running the daily job twice sends nothing new", async () => {
    const { Task } = await import("@/lib/db/models/task");
    const { User } = await import("@/lib/db/models/user");
    const { Candidate } = await import("@/lib/db/models/candidate");
    const { Notification } = await import("@/lib/db/models/notification");
    const { runDailyJob } = await import("@/lib/reminders/runner");
    const owner = await User.create({ name: "Owner", email: "o@example.com", passwordHash: "x", role: "compliance_associate" } as never);
    const cand = await Candidate.create({ candidateCode: "CND-1", legalName: "A B", email: "a@example.com", emailLower: "a@example.com", ownerId: owner._id, stage: "archived" });
    void cand;
    const today = new Date("2026-12-24T15:00:00Z");
    await Task.create({ candidateId: null, kind: "manual", category: "general", title: "T", dueDate: "2026-12-31", originalDueDate: "2026-12-31", ownerId: owner._id, source: "manual", createdBy: owner._id });
    const first = await runDailyJob({ now: today });
    const notes = await Notification.countDocuments();
    expect(first.sent).toBeGreaterThan(0);
    const second = await runDailyJob({ now: today });
    expect(second.sent).toBe(0);
    expect(await Notification.countDocuments()).toBe(notes);
  });
});
