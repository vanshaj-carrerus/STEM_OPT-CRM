import { describe, expect, it } from "vitest";
import { planReminders, taskTypeOf, type PlanCandidate, type PlanInput, type PlanTask, type PlanUser } from "@/lib/reminders/plan";
import { reminderKey } from "@/lib/reminders/engine";
import { resolveTimezone } from "@/lib/reminders/timezone";
import { bearerMatches } from "@/lib/reminders/cron-auth";

const users = new Map<string, PlanUser>(
  [
    { id: "owner", role: "compliance_associate", active: true, teamLeadId: "lead" },
    { id: "lead", role: "compliance_associate", active: true, teamLeadId: null },
    { id: "mgr", role: "compliance_manager", active: true },
    { id: "admin", role: "super_admin", active: true },
    { id: "lone", role: "compliance_associate", active: true, teamLeadId: null }, // no team lead
    { id: "gone", role: "compliance_associate", active: false },
  ].map((u) => [u.id, u]),
);
const cand: PlanCandidate = { id: "c1", name: "Asha Rao", email: "asha@example.com", ownerId: "owner" };
const candidates = new Map([[cand.id, cand]]);

const task = (over: Partial<PlanTask> = {}): PlanTask => ({
  id: "t1", candidateId: "c1", kind: "milestone", refKey: "milestone:stem_validation_6m:2026-12-31", title: "6-month validation",
  dueDate: "2026-12-31", status: "open", ownerId: "owner", escalationLevel: 0, today: "2026-12-24", ...over,
});
const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  tasks: [task()], candidates, users, existingKeys: new Set(), staffEmailEnabled: true, candidateEmailEnabled: false, ...over,
});
const keyFor = (t: PlanTask, channel: "in_app" | "email", offset: number | `overdue-L${number}`, audience: "staff" | "candidate" = "staff") =>
  reminderKey({ candidateId: t.candidateId ?? "none", taskType: taskTypeOf(t), dueDate: t.dueDate, channel, offset, audience });

describe("reminder planning (AC-08)", () => {
  it("plans in-app + email to the owner on an offset day (7 days before)", () => {
    const plan = planReminders(base());
    const sends = plan.filter((p) => p.mode === "send");
    expect(sends.map((p) => p.channel).sort()).toEqual(["email", "in_app"]);
    expect(sends.every((p) => p.offset === "7" && p.audience === "staff" && p.recipientIds.join() === "owner")).toBe(true);
    expect(sends[0].templateKey).toBe("staff.reminder");
  });

  it("plans nothing on a non-offset day once the earlier offsets were handled", () => {
    const t = task({ today: "2026-12-26" });
    const handled = new Set([30, 14, 7].map((o) => keyFor(t, "in_app", o)));
    expect(planReminders(base({ tasks: [t], existingKeys: handled }))).toEqual([]);
  });
  it("a task first seen on a non-offset day gets ONE catch-up reminder (never a burst)", () => {
    const plan = planReminders(base({ tasks: [task({ today: "2026-12-26" })] }));
    expect(plan.filter((p) => p.mode === "send" && p.channel === "in_app").map((p) => p.offset)).toEqual(["7"]);
  });

  it("running again after the keys were inserted plans nothing (idempotent day)", () => {
    const first = planReminders(base());
    const existing = new Set(first.map((p) => p.key));
    expect(planReminders(base({ existingKeys: existing }))).toEqual([]);
  });

  it("task created late: only the most urgent offset is sent, earlier ones recorded as skipped", () => {
    const plan = planReminders(base({ tasks: [task({ today: "2026-12-28" })] })); // 3 days out; 30,14,7 were missed
    const sent = plan.filter((p) => p.mode === "send" && p.channel === "in_app");
    const skipped = plan.filter((p) => p.mode === "skip");
    expect(sent.map((p) => p.offset)).toEqual(["3"]);
    expect(skipped.map((p) => p.offset).sort()).toEqual(["14", "30", "7"]);
    expect(skipped.every((p) => p.payload.body === "")).toBe(true);
  });

  it("email can be switched off (in-app only)", () => {
    const plan = planReminders(base({ staffEmailEnabled: false }));
    expect(plan.filter((p) => p.mode === "send").map((p) => p.channel)).toEqual(["in_app"]);
  });

  it("per-task-type offsets override the defaults", () => {
    // monthly reviews only at 10 days
    const t = task({ kind: "monthly_review", refKey: "monthly:cy:3", today: "2026-12-24" });
    const handled = new Set([keyFor(t, "in_app", 10)]);
    expect(planReminders(base({ tasks: [t], existingKeys: handled, offsetsByTaskType: { monthly_review: [10] } }))).toEqual([]);
    const t2 = task({ kind: "monthly_review", refKey: "monthly:cy:3", today: "2026-12-21" });
    const plan = planReminders(base({ tasks: [t2], offsetsByTaskType: { monthly_review: [10] } }));
    expect(plan.find((p) => p.mode === "send")?.offset).toBe("10");
  });

  it("two manual tasks with the same due date never share a dedupe key", () => {
    const a = task({ id: "a", kind: "manual", refKey: null });
    const b = task({ id: "b", kind: "manual", refKey: null });
    const keys = planReminders(base({ tasks: [a, b] })).map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("closed tasks produce nothing", () => {
    expect(planReminders(base({ tasks: [task({ status: "completed" })] }))).toEqual([]);
  });

  it("unowned task goes to the compliance managers instead of being dropped", () => {
    const c2 = new Map([[cand.id, { ...cand, ownerId: null }]]);
    const plan = planReminders(base({ tasks: [task({ ownerId: null })], candidates: c2 }));
    expect(plan[0].recipientIds).toEqual(["mgr"]);
  });

  it("inactive owner falls back to the candidate owner / managers", () => {
    const c2 = new Map([[cand.id, { ...cand, ownerId: null }]]);
    const plan = planReminders(base({ tasks: [task({ ownerId: "gone" })], candidates: c2 }));
    expect(plan[0].recipientIds).toEqual(["mgr"]);
  });
});

describe("candidate-facing reminders are separate and off by default", () => {
  const waiting = task({ status: "waiting_candidate" });
  it("no candidate reminder unless the setting is on", () => {
    expect(planReminders(base({ tasks: [waiting] })).some((p) => p.audience === "candidate")).toBe(false);
  });
  it("when on: separate template + key + audience, email channel only", () => {
    const plan = planReminders(base({ tasks: [waiting], candidateEmailEnabled: true }));
    const c = plan.filter((p) => p.audience === "candidate" && p.mode === "send");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ channel: "email", templateKey: "candidate.reminder", toEmail: "asha@example.com" });
    expect(c[0].payload.body).not.toMatch(/escalat|compliance manager|risk/i);
    const staff = plan.filter((p) => p.audience === "staff");
    expect(staff.every((p) => p.templateKey === "staff.reminder")).toBe(true);
    expect(new Set(plan.map((p) => p.key)).size).toBe(plan.length);
  });
  it("not sent to a candidate without an email, nor for tasks that are not candidate-facing", () => {
    const noEmail = new Map([[cand.id, { ...cand, email: "" }]]);
    expect(planReminders(base({ tasks: [waiting], candidates: noEmail, candidateEmailEnabled: true })).some((p) => p.audience === "candidate")).toBe(false);
    expect(planReminders(base({ candidateEmailEnabled: true })).some((p) => p.audience === "candidate")).toBe(false);
  });
});

describe("overdue escalation routing (owner → team lead 1bd → compliance manager 3bd → admin 5bd)", () => {
  // due Fri 2026-12-04; Mon 12-07 = 1 bd, Wed 12-09 = 3 bd, Fri 12-11 = 5 bd
  const due = "2026-12-04";
  const esc = (today: string, over: Partial<PlanInput> = {}, t: Partial<PlanTask> = {}) =>
    planReminders(base({ tasks: [task({ dueDate: due, today, ...t })], ...over })).filter((p) => p.mode === "send" && p.channel === "in_app");

  it("1 business day → the owner's team lead", () => {
    const r = esc("2026-12-07");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ level: 1, offset: "overdue-L1", recipientIds: ["lead"], templateKey: "staff.escalation" });
  });
  it("3 business days → compliance managers", () => {
    expect(esc("2026-12-09")[0]).toMatchObject({ level: 2, recipientIds: ["mgr"] });
  });
  it("5 business days → department admins", () => {
    expect(esc("2026-12-11")[0]).toMatchObject({ level: 3, recipientIds: ["admin"] });
  });
  it("missing team lead falls back up to the compliance manager (never silently dropped)", () => {
    const c2 = new Map([[cand.id, { ...cand, ownerId: "lone" }]]);
    const r = esc("2026-12-07", { candidates: c2 }, { ownerId: "lone" });
    expect(r[0].recipientIds).toEqual(["mgr"]);
  });
  it("business-day math honours holidays", () => {
    // Mon 12-07 is a holiday → still 0 business days on Monday → no team-lead escalation yet
    const r = esc("2026-12-07", { holidays: new Set(["2026-12-07"]) });
    expect(r.every((p) => p.level === 0)).toBe(true);
  });
  it("each level is notified once: existing keys suppress it, and lower missed rungs are only recorded as skipped", () => {
    const t = task({ dueDate: due, today: "2026-12-09" });
    const plan = planReminders(base({ tasks: [t] }));
    expect(plan.filter((p) => p.mode === "send" && p.channel === "in_app").map((p) => p.level)).toEqual([2]);
    expect(plan.filter((p) => p.mode === "skip").map((p) => p.level).sort()).toEqual([0, 1]);
    const existing = new Set(plan.map((p) => p.key));
    expect(planReminders(base({ tasks: [t], existingKeys: existing }))).toEqual([]);
    // next level on a later day still fires
    const later = planReminders(base({ tasks: [{ ...t, today: "2026-12-11" }], existingKeys: existing }));
    expect(later.find((p) => p.mode === "send")?.level).toBe(3);
  });
  it("uses the overdue key shape and never sends upcoming-style reminders after the due date", () => {
    const t = task({ dueDate: due, today: "2026-12-07" });
    const p = planReminders(base({ tasks: [t] })).find((x) => x.mode === "send")!;
    expect(p.key).toBe(keyFor(t, "in_app", "overdue-L1"));
    expect(planReminders(base({ tasks: [t] })).every((x) => x.kind === "escalation")).toBe(true);
  });
});

describe("timezone + cron auth", () => {
  it("record timezone, then owner timezone, then America/New_York", () => {
    expect(resolveTimezone("Asia/Kolkata", "America/Chicago")).toBe("Asia/Kolkata");
    expect(resolveTimezone(undefined, "America/Chicago")).toBe("America/Chicago");
    expect(resolveTimezone("Not/AZone", null)).toBe("America/New_York");
  });
  it("bearer comparison", () => {
    const secret = "a-very-long-cron-secret-value";
    expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
    expect(bearerMatches("Bearer wrong", secret)).toBe(false);
    expect(bearerMatches(secret, secret)).toBe(false);
    expect(bearerMatches(null, secret)).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
  });
});
