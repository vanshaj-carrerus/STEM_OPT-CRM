import { compareDates, type DateOnly } from "@/lib/compliance/dates";
import { fullTimeCptReviewFlag, type CptSegment } from "@/lib/compliance/milestones";
import type { UnemploymentLevel } from "./unemployment";

/** Risk-flag slugs owned by the immigration module. Other modules' flags in `candidate.riskFlags` are never touched. */
export const RISK = {
  cptFullTime12m: "immigration:cpt_full_time_12m_review",
  noVerifiedAuthorization: "immigration:active_employment_without_verified_authorization",
  unemploymentApproaching: "immigration:unemployment_days_approaching_limit",
  unemploymentAtLimit: "immigration:unemployment_days_at_limit",
  /** Sticky: set when clearance is automatically revoked, removed when clearance is granted again. */
  clearanceRevoked: "immigration:clearance_revoked",
} as const;

export const DERIVED_RISK_FLAGS: string[] = [RISK.cptFullTime12m, RISK.noVerifiedAuthorization, RISK.unemploymentApproaching, RISK.unemploymentAtLimit];

export const RISK_LABELS: Record<string, string> = {
  [RISK.cptFullTime12m]: "12+ months of full-time CPT at one education level: flagged for DSO/legal review (not a legal conclusion)",
  [RISK.noVerifiedAuthorization]: "Active employment recorded but no verified, in-date authorization covers today: review",
  [RISK.unemploymentApproaching]: "Unemployment days approaching a commonly cited limit: confirm with DSO",
  [RISK.unemploymentAtLimit]: "Unemployment days at or over a commonly cited limit: confirm with DSO",
  [RISK.clearanceRevoked]: "Clearance to work was automatically revoked because the supporting conditions stopped holding",
};

export interface CptPeriodLike {
  type: string;
  startDate: DateOnly;
  endDate: DateOnly;
  fullTime?: boolean;
  educationLevel?: string;
  verification: string;
}

/** Full-time CPT segments per education level, overlapping segments merged so shared days are not double counted. */
export function cptSegmentsFrom(periods: CptPeriodLike[], fallbackLevel = "unspecified"): CptSegment[] {
  const byLevel = new Map<string, CptSegment[]>();
  for (const p of periods) {
    if (p.type !== "CPT" || p.verification === "rejected" || !p.fullTime) continue;
    const level = (p.educationLevel || fallbackLevel).trim().toLowerCase();
    const list = byLevel.get(level) ?? [];
    list.push({ start: p.startDate, end: p.endDate, fullTime: true, educationLevel: level });
    byLevel.set(level, list);
  }
  const out: CptSegment[] = [];
  for (const [level, list] of byLevel) {
    const merged: CptSegment[] = [];
    for (const s of list.sort((a, b) => compareDates(a.start, b.start))) {
      const last = merged[merged.length - 1];
      if (last && compareDates(s.start, last.end) <= 0) {
        if (compareDates(s.end, last.end) > 0) last.end = s.end;
      } else merged.push({ ...s, educationLevel: level });
    }
    out.push(...merged);
  }
  return out;
}

/** Full-time CPT review flag via the engine (cumulative >= 12 months at one education level). Never a legal conclusion. */
export function cptReview(periods: CptPeriodLike[], fallbackLevel?: string) {
  return fullTimeCptReviewFlag(cptSegmentsFrom(periods, fallbackLevel));
}

export function deriveRiskFlags(i: {
  cptFlag: boolean;
  hasActiveEmployment: boolean;
  hasVerifiedCoverageToday: boolean;
  unemploymentLevel: UnemploymentLevel;
}): string[] {
  const flags: string[] = [];
  if (i.cptFlag) flags.push(RISK.cptFullTime12m);
  if (i.hasActiveEmployment && !i.hasVerifiedCoverageToday) flags.push(RISK.noVerifiedAuthorization);
  if (i.unemploymentLevel === "approaching") flags.push(RISK.unemploymentApproaching);
  if (i.unemploymentLevel === "at_limit") flags.push(RISK.unemploymentAtLimit);
  return flags;
}
