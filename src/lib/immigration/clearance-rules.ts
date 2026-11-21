import { compareDates, type DateOnly } from "@/lib/compliance/dates";
import type { ClearanceResult } from "@/lib/compliance/clearance";

/**
 * Pure helpers around the clearance engine (lib/compliance/clearance.ts). Nothing here reads payroll or payment
 * data: payroll completion never proves work authorization.
 */

export interface PeriodLike {
  _id: string;
  type: "CPT" | "OPT" | "STEM_OPT";
  startDate: DateOnly;
  endDate: DateOnly;
  employerId?: string | null;
  verification: "unverified" | "verified" | "rejected";
}

/**
 * Pick the authorization period a piece of work should be judged against.
 * CPT is employer-specific, so a CPT segment for the work employer wins; otherwise the period type follows the
 * candidate's authorization type. Among equals the period covering the reference date is preferred, then the latest.
 */
export function pickGoverningPeriod<P extends PeriodLike>(
  periods: P[],
  ctx: { authType?: string | null; workEmployerId?: string | null; plannedWorkStart?: DateOnly | null; today: DateOnly },
): P | null {
  let pool = periods.filter((p) => p.verification !== "rejected");
  if (!pool.length) return null;
  if (ctx.authType && ctx.authType !== "none") {
    const typed = pool.filter((p) => p.type === ctx.authType);
    if (typed.length) pool = typed;
  }
  if (pool.some((p) => p.type === "CPT") && ctx.workEmployerId) {
    const forEmployer = pool.filter((p) => p.type !== "CPT" || p.employerId === ctx.workEmployerId);
    if (forEmployer.length) pool = forEmployer;
  }
  const ref = ctx.plannedWorkStart ?? ctx.today;
  const covering = pool.filter((p) => compareDates(p.startDate, ref) <= 0 && compareDates(p.endDate, ref) >= 0);
  const pick = (list: P[]) => [...list].sort((a, b) => compareDates(b.endDate, a.endDate))[0] ?? null;
  return pick(covering) ?? pick(pool);
}

/**
 * Operational blockers layered on top of the engine: the evidence must be the right KIND of document
 * (CPT-endorsed I-20 for CPT; EAD card for OPT / STEM OPT) and the I-20 endorsement can't post-date the work start.
 */
export function extraClearanceBlockers(i: {
  type: "CPT" | "OPT" | "STEM_OPT";
  evidenceDocType?: string | null;
  i20EndorsementDate?: DateOnly | null;
  plannedWorkStart?: DateOnly | null;
}): string[] {
  const out: string[] = [];
  if (i.evidenceDocType) {
    if (i.type === "CPT" && i.evidenceDocType !== "i20") out.push("CPT evidence must be the endorsed I-20.");
    if (i.type !== "CPT" && i.evidenceDocType !== "ead_card") out.push("OPT / STEM OPT evidence must be the EAD card.");
  }
  if (i.type === "CPT" && i.i20EndorsementDate && i.plannedWorkStart && compareDates(i.i20EndorsementDate, i.plannedWorkStart) > 0) {
    out.push("The I-20 CPT endorsement date is after the work start date.");
  }
  return out;
}

export interface RevocationDecision {
  revoke: boolean;
  reasons: string[];
}

/**
 * Clearance is automatically revoked the moment the conditions that justified it stop holding:
 * expired authorization, edited dates, un-verified evidence, replaced evidence, ended employment...
 */
export function decideClearanceRevocation(i: {
  currentlyCleared: boolean;
  evaluation: Pick<ClearanceResult, "cleared" | "reasons">;
  clearedEvidenceDocId?: string | null;
  currentEvidenceDocId?: string | null;
}): RevocationDecision {
  if (!i.currentlyCleared) return { revoke: false, reasons: [] };
  const reasons = [...i.evaluation.reasons];
  if (i.clearedEvidenceDocId && i.currentEvidenceDocId !== i.clearedEvidenceDocId) {
    reasons.push("The evidence document the clearance was based on has changed.");
  }
  const revoke = !i.evaluation.cleared || reasons.length > 0;
  return { revoke, reasons };
}
