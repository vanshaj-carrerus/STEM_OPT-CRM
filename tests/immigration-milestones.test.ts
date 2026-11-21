import { describe, expect, it } from "vitest";
import { buildDesiredMilestones, planMilestones, STALE_MILESTONE_DAYS, type ExistingMilestoneTask } from "@/lib/immigration/milestone-plan";
import { addBusinessDays } from "@/lib/immigration/calendar";
import { changeReviewRefKey } from "@/lib/immigration/change-review";
import { changedMaterialFields } from "@/lib/employment/changes";

const STEM = { id: "p1", type: "STEM_OPT" as const, startDate: "2026-01-15", endDate: "2028-01-14" };
const OPT = { id: "p2", type: "OPT" as const, startDate: "2025-06-01", endDate: "2026-05-31" };

describe("buildDesiredMilestones (verified periods only; engines own the date math)", () => {
  it("creates nothing without verified periods", () => {
    expect(buildDesiredMilestones([], "2026-02-01")).toEqual([]);
  });
  it("STEM period: 6/12/18/24-month milestones + 90/60/30-day expiry warnings, keyed by type+anchor", () => {
    const d = buildDesiredMilestones([STEM], "2026-02-01");
    expect(d.map((m) => m.type).sort()).toEqual(
      ["authorization_expiry_30d", "authorization_expiry_60d", "authorization_expiry_90d", "stem_evaluation_12m", "stem_final_evaluation_24m", "stem_validation_18m", "stem_validation_6m"].sort(),
    );
    const six = d.find((m) => m.type === "stem_validation_6m")!;
    expect(six.refKey).toBe("milestone:stem_validation_6m:2026-01-15");
    expect(six.dueDate).toBe("2026-07-15");
    expect(d.every((m) => m.authorizationPeriodId === "p1")).toBe(true);
  });
  it("non-STEM period gets expiry milestones only", () => {
    const d = buildDesiredMilestones([OPT], "2026-01-01");
    expect(d.every((m) => m.type.startsWith("authorization_expiry"))).toBe(true);
    expect(d).toHaveLength(3);
  });
  it("is sorted by due date and de-duplicates identical (type, anchor) pairs", () => {
    const d = buildDesiredMilestones([OPT, { ...OPT, id: "dup" }], "2026-01-01");
    expect(d).toHaveLength(3);
    expect(d.map((m) => m.dueDate)).toEqual([...d.map((m) => m.dueDate)].sort());
  });
  it("long-past milestones of an ENDED authorization are not newly created; recent/ongoing ones are", () => {
    const today = "2027-01-01"; // OPT ended 2026-05-31
    const d = buildDesiredMilestones([OPT], today);
    expect(d.every((m) => m.skipCreate)).toBe(true);
    const ongoing = buildDesiredMilestones([STEM], "2027-01-01");
    expect(ongoing.find((m) => m.type === "stem_validation_6m")!.skipCreate).toBe(false); // overdue but auth not ended
    expect(STALE_MILESTONE_DAYS).toBeGreaterThan(0);
  });
});

describe("planMilestones (create / update / reopen / cancel; history preserved)", () => {
  const desired = buildDesiredMilestones([STEM], "2026-02-01");
  const k = (t: string) => desired.find((m) => m.type === t)!.refKey;
  const ex = (refKey: string, status: ExistingMilestoneTask["status"], dueDate = desired.find((m) => m.refKey === refKey)?.dueDate ?? "2026-01-01", snoozeCount = 0): ExistingMilestoneTask => ({
    refKey, status, dueDate, snoozeCount,
  });

  it("creates everything on first run", () => {
    const p = planMilestones([], desired);
    expect(p.create).toHaveLength(desired.length);
    expect(p.update).toEqual([]);
    expect(p.cancel).toEqual([]);
  });
  it("is idempotent when nothing changed", () => {
    const p = planMilestones(desired.map((d) => ex(d.refKey, "open")), desired);
    expect(p.create).toEqual([]);
    expect(p.update).toEqual([]);
    expect(p.reopen).toEqual([]);
    expect(p.cancel).toEqual([]);
    expect(p.keep).toHaveLength(desired.length);
  });
  it("cancels OPEN tasks whose verified date was corrected/removed, but keeps completed and waived history", () => {
    const stale = [
      ex("milestone:stem_validation_6m:2025-12-01", "open", "2026-06-01"),
      ex("milestone:stem_validation_18m:2025-12-01", "in_progress", "2027-06-01"),
      ex("milestone:stem_evaluation_12m:2025-12-01", "completed", "2026-12-01"),
      ex("milestone:stem_final_evaluation_24m:2025-12-01", "waived", "2027-12-01"),
      ex("milestone:authorization_expiry_30d:2025-12-01", "cancelled", "2027-01-01"),
    ];
    const p = planMilestones(stale, []);
    expect(p.cancel.sort()).toEqual(["milestone:stem_validation_18m:2025-12-01", "milestone:stem_validation_6m:2025-12-01"]);
    expect(p.keep.sort()).toEqual([
      "milestone:authorization_expiry_30d:2025-12-01",
      "milestone:stem_evaluation_12m:2025-12-01",
      "milestone:stem_final_evaluation_24m:2025-12-01",
    ]);
  });
  it("re-dates only open, never-snoozed tasks", () => {
    const key = k("stem_final_evaluation_24m");
    expect(planMilestones([ex(key, "open", "2027-01-01")], desired).update).toEqual([{ refKey: key, from: "2027-01-01", to: desired.find((m) => m.refKey === key)!.dueDate }]);
    expect(planMilestones([ex(key, "open", "2027-01-01", 1)], desired).update).toEqual([]);
    expect(planMilestones([ex(key, "waiting_dso", "2027-01-01")], desired).update).toEqual([]);
    expect(planMilestones([ex(key, "completed", "2027-01-01")], desired).update).toEqual([]);
  });
  it("reopens a cancelled task when its verified date comes back (un-verify then re-verify)", () => {
    const key = k("stem_validation_6m");
    const p = planMilestones([ex(key, "cancelled")], desired);
    expect(p.reopen.map((d) => d.refKey)).toEqual([key]);
    expect(p.create.map((d) => d.refKey)).not.toContain(key);
  });
  it("never reopens completed work and skips creation for stale milestones of ended authorizations", () => {
    const key = k("stem_validation_6m");
    expect(planMilestones([ex(key, "completed")], desired).reopen).toEqual([]);
    const old = buildDesiredMilestones([OPT], "2027-01-01");
    expect(planMilestones([], old).create).toEqual([]);
    // ...but an already-open one for the ended authorization is kept, not cancelled
    const p = planMilestones([ex(old[0].refKey, "open", old[0].dueDate)], old);
    expect(p.cancel).toEqual([]);
  });
});

describe("change-review helpers (AC-06)", () => {
  it("refKey is stable for the same field set, day and summary; differs otherwise", () => {
    const a = changeReviewRefKey(["hours", "employer"], "2026-11-21", "Employer changed");
    expect(a).toBe(changeReviewRefKey(["employer", "hours", "employer"], "2026-11-21", " employer changed "));
    expect(a).not.toBe(changeReviewRefKey(["employer", "hours"], "2026-11-22", "Employer changed"));
    expect(a).not.toBe(changeReviewRefKey(["employer", "hours"], "2026-11-21", "Something else"));
    expect(a.startsWith("change:employer+hours:2026-11-21:")).toBe(true);
  });
  it("due date is 3 business days out, skipping weekends and holidays", () => {
    expect(addBusinessDays("2026-11-20", 3)).toBe("2026-11-25"); // Fri -> Mon, Tue, Wed
    expect(addBusinessDays("2026-11-20", 3, new Set(["2026-11-23"]))).toBe("2026-11-26");
    expect(addBusinessDays("2026-11-21", 0)).toBe("2026-11-21");
  });
  it("detects employer / hours / compensation / duties / worksite changes and ignores the rest", () => {
    const before = { employerId: "e1", hoursPerWeek: 40, payTerms: "$30/h", jobTitle: "Analyst", jobDuties: "SQL", worksiteName: "HQ" };
    expect(changedMaterialFields(before, before).fields).toEqual([]);
    expect(changedMaterialFields(before, { ...before, employerId: "e2" }).fields).toEqual(["employer"]);
    expect(changedMaterialFields(before, { ...before, hoursPerWeek: 20, payTerms: "$25/h" }).fields).toEqual(["hours", "compensation"]);
    expect(changedMaterialFields(before, { ...before, jobDuties: "ML", worksiteName: "Client" }).fields).toEqual(["jobDuties", "worksite"]);
    expect(changedMaterialFields({ ...before, jobDuties: undefined }, { ...before, jobDuties: "" }).fields).toEqual([]);
  });
});
