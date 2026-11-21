import { describe, expect, it } from "vitest";
import { evaluateClearance, type ClearanceInput } from "@/lib/compliance/clearance";
import {
  decideClearanceRevocation, extraClearanceBlockers, pickGoverningPeriod, type PeriodLike,
} from "@/lib/immigration/clearance-rules";
import { cptReview, cptSegmentsFrom, deriveRiskFlags, RISK } from "@/lib/immigration/flags-rules";
import {
  mergeUnemployment, totalUnemploymentDays, unemploymentStatus,
} from "@/lib/immigration/unemployment";

const ok: ClearanceInput = {
  type: "OPT",
  authStart: "2026-01-01",
  authEnd: "2026-12-31",
  plannedWorkStart: "2026-02-01",
  evidenceDocumentId: "doc1",
  evidenceVerified: true,
  verifiedById: "u1",
  today: "2026-03-01",
};

describe("clearance-revocation decision", () => {
  it("does nothing when not currently cleared", () => {
    const e = evaluateClearance({ ...ok, evidenceVerified: false });
    expect(decideClearanceRevocation({ currentlyCleared: false, evaluation: e })).toEqual({ revoke: false, reasons: [] });
  });
  it("keeps clearance while all conditions hold", () => {
    const e = evaluateClearance(ok);
    expect(e.cleared).toBe(true);
    expect(decideClearanceRevocation({ currentlyCleared: true, evaluation: e, clearedEvidenceDocId: "doc1", currentEvidenceDocId: "doc1" }).revoke).toBe(false);
  });
  it("revokes when the authorization expires", () => {
    const e = evaluateClearance({ ...ok, today: "2027-01-02" });
    const d = decideClearanceRevocation({ currentlyCleared: true, evaluation: e, clearedEvidenceDocId: "doc1", currentEvidenceDocId: "doc1" });
    expect(d.revoke).toBe(true);
    expect(d.reasons.join(" ")).toMatch(/expired/i);
  });
  it("revokes when evidence is un-verified or dates are edited so work start precedes the authorization", () => {
    expect(decideClearanceRevocation({ currentlyCleared: true, evaluation: evaluateClearance({ ...ok, evidenceVerified: false }) }).revoke).toBe(true);
    const edited = evaluateClearance({ ...ok, authStart: "2026-03-01" }); // work start 2026-02-01 now precedes EAD start
    expect(decideClearanceRevocation({ currentlyCleared: true, evaluation: edited }).revoke).toBe(true);
  });
  it("revokes when the evidence document was swapped after clearing", () => {
    const d = decideClearanceRevocation({ currentlyCleared: true, evaluation: evaluateClearance(ok), clearedEvidenceDocId: "doc1", currentEvidenceDocId: "doc2" });
    expect(d.revoke).toBe(true);
    expect(d.reasons.join(" ")).toMatch(/evidence document/i);
  });
});

describe("clearance guards (payroll never implies authorization)", () => {
  it("ClearanceInput has no payroll/payment inputs, and unverified evidence can never clear", () => {
    expect(Object.keys(ok).some((k) => /payroll|payment|paid/i.test(k))).toBe(false);
    const r = evaluateClearance({ ...ok, evidenceVerified: false });
    expect(r.cleared).toBe(false);
  });
  it("CPT: start before authorized start is blocked", () => {
    const r = evaluateClearance({ ...ok, type: "CPT", authEmployerId: "e1", workEmployerId: "e1", plannedWorkStart: "2025-12-15" });
    expect(r.cleared).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/before the authorized CPT start/);
  });
  it("evidence kind: CPT needs an I-20, OPT/STEM needs the EAD card; I-20 endorsement after start is a blocker", () => {
    expect(extraClearanceBlockers({ type: "CPT", evidenceDocType: "ead_card" })).toHaveLength(1);
    expect(extraClearanceBlockers({ type: "CPT", evidenceDocType: "i20" })).toEqual([]);
    expect(extraClearanceBlockers({ type: "OPT", evidenceDocType: "i20" })).toHaveLength(1);
    expect(extraClearanceBlockers({ type: "STEM_OPT", evidenceDocType: "ead_card" })).toEqual([]);
    expect(extraClearanceBlockers({ type: "CPT", evidenceDocType: "i20", i20EndorsementDate: "2026-03-01", plannedWorkStart: "2026-02-01" })).toHaveLength(1);
  });
});

describe("pickGoverningPeriod", () => {
  const p = (id: string, type: PeriodLike["type"], s: string, e: string, employerId?: string): PeriodLike => ({ _id: id, type, startDate: s, endDate: e, employerId, verification: "verified" });
  it("CPT is employer-specific: picks the segment for the work employer", () => {
    const periods = [p("a", "CPT", "2026-01-01", "2026-06-30", "e1"), p("b", "CPT", "2026-01-01", "2026-06-30", "e2")];
    expect(pickGoverningPeriod(periods, { authType: "CPT", workEmployerId: "e2", plannedWorkStart: "2026-02-01", today: "2026-03-01" })?._id).toBe("b");
  });
  it("prefers the period covering the work start, else the latest; ignores rejected", () => {
    const periods = [p("old", "OPT", "2024-01-01", "2024-12-31"), p("cur", "OPT", "2025-01-01", "2025-12-31"), { ...p("rej", "OPT", "2026-01-01", "2026-12-31"), verification: "rejected" as const }];
    expect(pickGoverningPeriod(periods, { authType: "OPT", plannedWorkStart: "2025-06-01", today: "2026-03-01" })?._id).toBe("cur");
    expect(pickGoverningPeriod(periods, { authType: "OPT", today: "2026-03-01" })?._id).toBe("cur");
    expect(pickGoverningPeriod([], { today: "2026-03-01" })).toBeNull();
  });
  it("follows the candidate's authorization type when available", () => {
    const periods = [p("opt", "OPT", "2025-01-01", "2025-12-31"), p("stem", "STEM_OPT", "2026-01-01", "2027-12-31")];
    expect(pickGoverningPeriod(periods, { authType: "STEM_OPT", today: "2026-03-01" })?._id).toBe("stem");
  });
});

describe("unemployment-day math", () => {
  it("counts both end dates (inclusive)", () => {
    expect(totalUnemploymentDays([{ startDate: "2026-01-01", endDate: "2026-01-10" }], "2026-12-31")).toBe(10);
    expect(totalUnemploymentDays([{ startDate: "2026-01-01", endDate: "2026-01-01" }], "2026-12-31")).toBe(1);
  });
  it("merges overlapping and adjacent periods so days are not double counted", () => {
    const spans = [
      { startDate: "2026-01-01", endDate: "2026-01-10" },
      { startDate: "2026-01-05", endDate: "2026-01-15" }, // overlaps
      { startDate: "2026-01-16", endDate: "2026-01-20" }, // adjacent
      { startDate: "2026-02-01", endDate: "2026-02-03" },
      { startDate: "2026-02-02", endDate: "2026-02-02" }, // contained
    ];
    expect(mergeUnemployment(spans, "2026-12-31")).toEqual([{ start: "2026-01-01", end: "2026-01-20" }, { start: "2026-02-01", end: "2026-02-03" }]);
    expect(totalUnemploymentDays(spans, "2026-12-31")).toBe(23);
  });
  it("ongoing periods count to today; future periods and reversed ranges are ignored", () => {
    expect(totalUnemploymentDays([{ startDate: "2026-03-01", endDate: null }], "2026-03-10")).toBe(10);
    expect(totalUnemploymentDays([{ startDate: "2026-04-01", endDate: "2026-04-30" }], "2026-03-10")).toBe(0);
    expect(totalUnemploymentDays([{ startDate: "2026-03-10", endDate: "2026-03-01" }], "2026-03-31")).toBe(0);
  });
  it("flags approaching / at the commonly cited limits (90 OPT, 150 incl. STEM) with a confirm-with-DSO label", () => {
    expect(unemploymentStatus(10, "OPT").level).toBe("ok");
    expect(unemploymentStatus(72, "OPT").level).toBe("approaching");
    expect(unemploymentStatus(90, "OPT").level).toBe("at_limit");
    expect(unemploymentStatus(100, "STEM_OPT").level).toBe("ok");
    expect(unemploymentStatus(120, "STEM_OPT").level).toBe("approaching");
    expect(unemploymentStatus(150, "STEM_OPT")).toMatchObject({ level: "at_limit", limit: 150, remaining: 0 });
    for (const t of ["OPT", "STEM_OPT"]) expect(unemploymentStatus(95, t).label).toMatch(/confirm with DSO/i);
  });
});

describe("full-time CPT review flag (via engine)", () => {
  const seg = (s: string, e: string, fullTime = true, educationLevel = "Master's") => ({ type: "CPT", startDate: s, endDate: e, fullTime, educationLevel, verification: "unverified" });
  it("flags >= 12 months cumulative full-time CPT at one level, with non-legal wording", () => {
    const r = cptReview([seg("2025-01-01", "2025-06-30"), seg("2025-09-01", "2026-03-31")]);
    expect(r.flag).toBe(true);
    expect(r.message).toMatch(/not an automatic legal conclusion/i);
  });
  it("does not flag part-time, different levels, or under 12 months", () => {
    expect(cptReview([seg("2025-01-01", "2026-03-31", false)]).flag).toBe(false);
    expect(cptReview([seg("2025-01-01", "2025-09-30", true, "Bachelor's"), seg("2025-10-01", "2026-06-30", true, "Master's")]).flag).toBe(false);
    expect(cptReview([seg("2025-01-01", "2025-06-30")]).flag).toBe(false);
  });
  it("merges overlapping full-time segments so shared days are not double counted; ignores rejected", () => {
    const segs = cptSegmentsFrom([seg("2025-01-01", "2025-07-31"), seg("2025-06-01", "2025-09-30")]);
    expect(segs).toHaveLength(1);
    expect(cptReview([seg("2025-01-01", "2025-07-31"), seg("2025-01-01", "2025-07-31")]).flag).toBe(false);
    expect(cptReview([{ ...seg("2025-01-01", "2026-03-31"), verification: "rejected" }]).flag).toBe(false);
  });
  it("derives immigration risk flags", () => {
    expect(deriveRiskFlags({ cptFlag: true, hasActiveEmployment: true, hasVerifiedCoverageToday: false, unemploymentLevel: "at_limit" }).sort()).toEqual(
      [RISK.cptFullTime12m, RISK.noVerifiedAuthorization, RISK.unemploymentAtLimit].sort(),
    );
    expect(deriveRiskFlags({ cptFlag: false, hasActiveEmployment: false, hasVerifiedCoverageToday: false, unemploymentLevel: "ok" })).toEqual([]);
  });
});
