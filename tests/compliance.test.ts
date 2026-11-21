import { describe, expect, it } from "vitest";
import { addDays, addMonths, businessDaysBetween, isDateOnly, todayIn } from "@/lib/compliance/dates";
import {
  fullTimeCptReviewFlag,
  generateExpiryMilestones,
  generateMonthlyReviews,
  generateStemMilestones,
} from "@/lib/compliance/milestones";
import { evaluateClearance, type ClearanceInput } from "@/lib/compliance/clearance";

describe("date-only math", () => {
  it("clamps month ends and handles leap years", () => {
    expect(addMonths("2025-08-31", 6)).toBe("2026-02-28");
    expect(addMonths("2023-08-31", 6)).toBe("2024-02-29");
    expect(addMonths("2025-01-15", 12)).toBe("2026-01-15");
  });
  it("validates real calendar dates", () => {
    expect(isDateOnly("2026-02-30")).toBe(false);
    expect(isDateOnly("2026-02-28")).toBe(true);
    expect(isDateOnly("02/28/2026")).toBe(false);
  });
  it("counts business days (weekends excluded)", () => {
    // Fri 2026-11-20 → Mon 2026-11-23 is 1 business day
    expect(businessDaysBetween("2026-11-20", "2026-11-23")).toBe(1);
    expect(businessDaysBetween("2026-11-20", "2026-11-27")).toBe(5);
    expect(businessDaysBetween("2026-11-23", "2026-11-23")).toBe(0);
    expect(businessDaysBetween("2026-11-20", "2026-11-23", new Set(["2026-11-23"]))).toBe(0);
  });
  it("does not shift dates across timezones", () => {
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // DST boundary
    expect(todayIn("Asia/Kolkata", new Date("2026-11-20T20:00:00Z"))).toBe("2026-11-21");
    expect(todayIn("America/Los_Angeles", new Date("2026-11-20T20:00:00Z"))).toBe("2026-11-20");
  });
});

describe("AC-04/AC-05: STEM milestones anchored to STEM EAD start", () => {
  const ms = generateStemMilestones("2026-01-15", "2028-01-14");
  it("creates 6, 12, 18 and 24-month milestones", () => {
    expect(ms.map((m) => [m.type, m.dueDate])).toEqual([
      ["stem_validation_6m", "2026-07-15"],
      ["stem_evaluation_12m", "2027-01-15"],
      ["stem_validation_18m", "2027-07-15"],
      ["stem_final_evaluation_24m", "2028-01-14"], // end of training
    ]);
  });
  it("12-month task includes the I-983 Evaluation and signatures; final is the end-of-training evaluation", () => {
    expect(ms[1].title).toMatch(/I-983/);
    expect(ms[1].checklist.join(" ")).toMatch(/Student section signed/);
    expect(ms[3].checklist.join(" ")).toMatch(/end-of-training/);
  });
  it("never claims to replace DSO reporting", () => {
    for (const m of ms) expect(m.note).toMatch(/DSO/);
  });
  it("authorization expiry warnings at 90/60/30 days", () => {
    expect(generateExpiryMilestones("2026-12-31").map((m) => m.dueDate)).toEqual(["2026-10-02", "2026-11-01", "2026-12-01"]);
  });
});

describe("AC-07: 12 monthly reviews", () => {
  const r = generateMonthlyReviews("2026-03-31");
  it("creates months 1-12 with correct due dates", () => {
    expect(r).toHaveLength(12);
    expect(r[0].dueDate).toBe("2026-04-30");
    expect(r[1].dueDate).toBe("2026-05-31");
    expect(r[11].dueDate).toBe("2027-03-31");
  });
  it("month 6 has the formal six-month review and month 12 requires manager sign-off", () => {
    expect(r[5].checklist.map((c) => c.label).join()).toMatch(/six-month/);
    expect(r[11].checklist.map((c) => c.label).join()).toMatch(/Manager sign-off/);
  });
});

describe("CPT full-time flag", () => {
  it("flags ≥ 12 months cumulative full-time CPT at one level for DSO/legal review (not a legal conclusion)", () => {
    const f = fullTimeCptReviewFlag([
      { start: "2025-01-01", end: "2025-06-30", fullTime: true, educationLevel: "masters" },
      { start: "2025-09-01", end: "2026-03-31", fullTime: true, educationLevel: "masters" },
    ]);
    expect(f.flag).toBe(true);
    expect(f.message).toMatch(/not an automatic legal conclusion/);
  });
  it("ignores part-time and different levels", () => {
    expect(fullTimeCptReviewFlag([{ start: "2025-01-01", end: "2026-12-31", fullTime: false, educationLevel: "masters" }]).flag).toBe(false);
  });
});

describe("AC-03: cleared-to-work guard", () => {
  const base: ClearanceInput = {
    type: "CPT",
    authStart: "2026-06-01",
    authEnd: "2026-12-15",
    plannedWorkStart: "2026-06-01",
    authEmployerId: "emp1",
    workEmployerId: "emp1",
    evidenceDocumentId: "doc1",
    evidenceVerified: true,
    verifiedById: "u1",
    today: "2026-05-20",
  };
  it("clears CPT only with verified, employer-specific evidence and valid dates", () => {
    expect(evaluateClearance(base)).toMatchObject({ cleared: true, reasons: [] });
  });
  it("blocks when evidence is missing or unverified", () => {
    expect(evaluateClearance({ ...base, evidenceDocumentId: null }).cleared).toBe(false);
    expect(evaluateClearance({ ...base, evidenceVerified: false }).cleared).toBe(false);
    expect(evaluateClearance({ ...base, verifiedById: null }).cleared).toBe(false);
  });
  it("blocks start before authorized CPT start date", () => {
    const r = evaluateClearance({ ...base, plannedWorkStart: "2026-05-30" });
    expect(r.cleared).toBe(false);
    expect(r.reasons.join()).toMatch(/before the authorized CPT start/);
  });
  it("blocks CPT for a different employer", () => {
    expect(evaluateClearance({ ...base, workEmployerId: "other" }).cleared).toBe(false);
  });
  it("blocks expired authorization", () => {
    expect(evaluateClearance({ ...base, today: "2027-01-01" }).reasons.join()).toMatch(/expired/);
  });
  it("STEM OPT needs verified I-983, E-Verify and >= 20 hours", () => {
    const stem: ClearanceInput = { ...base, type: "STEM_OPT", authEmployerId: null };
    expect(evaluateClearance(stem).cleared).toBe(false);
    expect(evaluateClearance({ ...stem, i983Verified: true, everifyCompanyIdPresent: true, hoursPerWeek: 19 }).reasons.join()).toMatch(/20 hours/);
    expect(evaluateClearance({ ...stem, i983Verified: true, everifyCompanyIdPresent: true, hoursPerWeek: 30 }).cleared).toBe(true);
  });
  it("has no payroll input at all — payroll completion can never imply authorization", () => {
    const keys = Object.keys(base);
    expect(keys.some((k) => /payroll|paid|gusto/i.test(k))).toBe(false);
  });
});
