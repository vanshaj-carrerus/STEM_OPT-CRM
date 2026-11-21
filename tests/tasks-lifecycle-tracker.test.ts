import { describe, expect, it } from "vitest";
import { evaluateCompletion, evaluateStatusChange, evaluateWaiver, planSnooze, editPermissionForKind } from "@/lib/tasks/lifecycle";
import { canCloseCycle, defaultAnchorFor, mayStartNextCycle, monthlyRefKey, nextCycleAnchor, planCycle } from "@/lib/tracker/cycle";

const baseTask = {
  kind: "milestone" as const, status: "open" as const, dueDate: "2026-12-10", originalDueDate: "2026-12-10",
  checklist: [{ label: "a", done: true }], snoozes: [], escalationLevel: 2,
};

describe("snooze (reason + later date; originalDueDate and history preserved)", () => {
  it("rejects missing reason, same/earlier date, and invalid date", () => {
    expect(planSnooze(baseTask, { newDueDate: "2026-12-20", reason: "", by: "u" }).ok).toBe(false);
    expect(planSnooze(baseTask, { newDueDate: "2026-12-10", reason: "waiting on DSO", by: "u" }).ok).toBe(false);
    expect(planSnooze(baseTask, { newDueDate: "2026-12-01", reason: "waiting on DSO", by: "u" }).ok).toBe(false);
    expect(planSnooze(baseTask, { newDueDate: "nope", reason: "waiting on DSO", by: "u" }).ok).toBe(false);
  });
  it("preserves the original due date across repeated snoozes and keeps every entry", () => {
    const a = planSnooze(baseTask, { newDueDate: "2026-12-20", reason: "Candidate travelling", by: "u1" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.patch.originalDueDate).toBe("2026-12-10");
    expect(a.patch.escalationLevel).toBe(0);
    const b = planSnooze({ ...baseTask, ...a.patch }, { newDueDate: "2027-01-05", reason: "Still waiting", by: "u2" });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.patch.originalDueDate).toBe("2026-12-10");
    expect(b.patch.dueDate).toBe("2027-01-05");
    expect(b.patch.snoozes.map((s) => [s.from, s.to, s.by])).toEqual([
      ["2026-12-10", "2026-12-20", "u1"],
      ["2026-12-20", "2027-01-05", "u2"],
    ]);
  });
  it("finished tasks cannot be snoozed", () => {
    expect(planSnooze({ ...baseTask, status: "completed" }, { newDueDate: "2026-12-20", reason: "because", by: "u" }).ok).toBe(false);
  });
});

describe("completion / waiver / status rules", () => {
  it("needs an outcome and evidence (non-manual); manual tasks only need an outcome", () => {
    expect(evaluateCompletion(baseTask, { outcome: "Done" }).ok).toBe(false);
    expect(evaluateCompletion(baseTask, { outcome: "Done", evidenceNote: "Filed confirmation" }).ok).toBe(true);
    expect(evaluateCompletion(baseTask, { outcome: "Done", documentId: "doc-1" }).ok).toBe(true);
    expect(evaluateCompletion({ ...baseTask, kind: "manual" }, { outcome: "Done" }).ok).toBe(true);
    expect(evaluateCompletion(baseTask, { evidenceNote: "x" }).ok).toBe(false);
  });
  it("unfinished checklist blocks completion unless a waiver reason is given", () => {
    const t = { ...baseTask, checklist: [{ label: "a", done: true }, { label: "b", done: false }] };
    const input = { outcome: "Done", evidenceNote: "note" };
    expect(evaluateCompletion(t, input).ok).toBe(false);
    const r = evaluateCompletion(t, { ...input, checklistWaiverReason: "Not applicable to this employer" });
    expect(r).toEqual({ ok: true, waivedChecklist: true });
  });
  it("waiver needs a reason; finished tasks cannot be waived or re-statused", () => {
    expect(evaluateWaiver({ status: "open" }, "").ok).toBe(false);
    expect(evaluateWaiver({ status: "open" }, "Not required for CPT").ok).toBe(true);
    expect(evaluateWaiver({ status: "waived" }, "Not required for CPT").ok).toBe(false);
    expect(evaluateStatusChange("completed", "open").ok).toBe(false);
    expect(evaluateStatusChange("open", "waiting_dso").ok).toBe(true);
    expect(evaluateStatusChange("open", "completed").ok).toBe(false);
  });
  it("monthly reviews need tracker.edit, other tasks tasks.edit", () => {
    expect(editPermissionForKind("monthly_review")).toBe("tracker.edit");
    expect(editPermissionForKind("milestone")).toBe("tasks.edit");
  });
});

describe("12-month tracker cycle (AC-07)", () => {
  it("generates months 1–12 due N months after the anchor, with custom checklists overriding defaults", () => {
    const p = planCycle({ anchor: "2026-01-31", anchorReason: "Candidate start date", defaultAnchor: "2026-01-31", checklists: { 2: ["Custom A", "Custom B"] } });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.reviews).toHaveLength(12);
    expect(p.reviews[0].dueDate).toBe("2026-02-28"); // month-end clamp
    expect(p.reviews[11].dueDate).toBe("2027-01-31");
    expect(p.reviews[1].checklist.map((c) => c.label)).toEqual(["Custom A", "Custom B"]);
    expect(p.reviews[2].checklist.length).toBeGreaterThan(0); // untouched months keep defaults
    expect(p.customAnchor).toBe(false);
  });
  it("requires a recorded anchor reason and flags a custom anchor", () => {
    expect(planCycle({ anchor: "2026-03-01", anchorReason: "", defaultAnchor: "2026-01-01" }).ok).toBe(false);
    expect(planCycle({ anchor: "2026-03-01", anchorReason: "abc", defaultAnchor: "2026-01-01" }).ok).toBe(false);
    const p = planCycle({ anchor: "2026-03-01", anchorReason: "Employment began at the new client", defaultAnchor: "2026-01-01" });
    expect(p.ok && p.customAnchor && p.anchorReason).toBe("Employment began at the new client");
    expect(planCycle({ anchor: "bad", anchorReason: "valid reason", defaultAnchor: "2026-01-01" }).ok).toBe(false);
  });
  it("default anchor = authorization start, else onboarding date in the record timezone", () => {
    expect(defaultAnchorFor({ eadStart: "2026-05-01", createdAt: new Date("2026-06-01T00:00:00Z") }, "America/New_York")).toBe("2026-05-01");
    expect(defaultAnchorFor({ createdAt: new Date("2026-06-01T02:00:00Z") }, "America/New_York")).toBe("2026-05-31");
  });
  it("month tasks use a stable refKey", () => {
    expect(monthlyRefKey("cy1", 3)).toBe("monthly:cy1:3");
  });
  const months = (status: (n: number) => string) => Array.from({ length: 12 }, (_, i) => ({ monthNumber: i + 1, status: status(i + 1) }));
  it("close rules: manager sign-off, all 12 months completed/waived, review note", () => {
    const done = months(() => "completed");
    expect(canCloseCycle({ reviews: done, hasSignoffPermission: true, note: "Reviewed" }).ok).toBe(true);
    expect(canCloseCycle({ reviews: done, hasSignoffPermission: false, note: "Reviewed" }).ok).toBe(false);
    expect(canCloseCycle({ reviews: done, hasSignoffPermission: true, note: "" }).ok).toBe(false);
    expect(canCloseCycle({ reviews: months((n) => (n === 12 ? "open" : "waived")), hasSignoffPermission: true, note: "ok ok" }).ok).toBe(false);
    expect(canCloseCycle({ reviews: months((n) => (n === 5 ? "cancelled" : "completed")), hasSignoffPermission: true, note: "ok ok" }).ok).toBe(false);
    expect(canCloseCycle({ reviews: done.slice(0, 11), hasSignoffPermission: true, note: "ok ok" }).ok).toBe(false);
  });
  it("next cycle only when auto setting is on or a manager triggers it", () => {
    const s = { hasOpenCycle: false, hasClosedCycle: true };
    expect(mayStartNextCycle({ ...s, autoNextCycle: false, triggeredByManager: false })).toBe(false);
    expect(mayStartNextCycle({ ...s, autoNextCycle: true, triggeredByManager: false })).toBe(true);
    expect(mayStartNextCycle({ ...s, autoNextCycle: false, triggeredByManager: true })).toBe(true);
    expect(mayStartNextCycle({ hasOpenCycle: true, hasClosedCycle: true, autoNextCycle: true, triggeredByManager: true })).toBe(false);
    expect(mayStartNextCycle({ hasOpenCycle: false, hasClosedCycle: false, autoNextCycle: false, triggeredByManager: false })).toBe(true);
    expect(nextCycleAnchor("2026-01-15")).toBe("2027-01-15");
  });
});
