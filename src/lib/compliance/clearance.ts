import { compareDates, type DateOnly } from "./dates";

/**
 * "Cleared to work / start" guard (AC-03, long spec §3, §18).
 * Rules enforced here:
 *  - A CRM checkbox alone is never enough: verified source evidence + an authorized reviewer are required.
 *  - CPT: employer-specific segment, endorsed I-20 evidence, planned start within approved dates.
 *  - OPT/STEM: planned start must not precede the EAD start date (and not after EAD end).
 *  - STEM additionally needs a verified I-983 and employer E-Verify info; hours must be >= 20/week.
 *  - Payroll status is deliberately NOT an input — payroll completion never proves work authorization.
 */
export type AuthType = "CPT" | "OPT" | "STEM_OPT";

export interface ClearanceInput {
  type: AuthType;
  authStart?: DateOnly | null;
  authEnd?: DateOnly | null;
  plannedWorkStart?: DateOnly | null;
  /** Employer on the authorization segment vs employer the candidate will work for (CPT is employer-specific). */
  authEmployerId?: string | null;
  workEmployerId?: string | null;
  evidenceDocumentId?: string | null; // I-20 (CPT) or EAD card (OPT/STEM)
  evidenceVerified?: boolean;
  verifiedById?: string | null;
  i983Verified?: boolean; // STEM only
  everifyCompanyIdPresent?: boolean; // STEM only
  hoursPerWeek?: number | null; // STEM only
  today: DateOnly;
}

export interface ClearanceResult {
  cleared: boolean;
  reasons: string[]; // blockers; empty when cleared
  warnings: string[];
}

export function evaluateClearance(i: ClearanceInput): ClearanceResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (!i.evidenceDocumentId) reasons.push("No authorization evidence document is attached.");
  if (!i.evidenceVerified || !i.verifiedById) reasons.push("Authorization evidence has not been verified by an authorized reviewer.");
  if (!i.authStart || !i.authEnd) reasons.push("Authorization start and end dates are missing.");
  if (!i.plannedWorkStart) reasons.push("Planned work start date is missing.");

  if (i.authStart && i.plannedWorkStart && compareDates(i.plannedWorkStart, i.authStart) < 0) {
    reasons.push(
      i.type === "CPT"
        ? "Work start is before the authorized CPT start date."
        : "Work start is before the EAD start date.",
    );
  }
  if (i.authEnd && i.plannedWorkStart && compareDates(i.plannedWorkStart, i.authEnd) > 0) {
    reasons.push("Work start is after the authorization end date.");
  }
  if (i.authEnd && compareDates(i.authEnd, i.today) < 0) reasons.push("Authorization has expired.");

  if (i.type === "CPT") {
    if (!i.authEmployerId) reasons.push("CPT must be linked to a specific employer.");
    else if (i.workEmployerId && i.authEmployerId !== i.workEmployerId) {
      reasons.push("CPT authorization is for a different employer than the one this work is for.");
    }
  }

  if (i.type === "STEM_OPT") {
    if (!i.i983Verified) reasons.push("Form I-983 has not been verified (version/signatures).");
    if (!i.everifyCompanyIdPresent) reasons.push("Employer E-Verify details are missing.");
    if (i.hoursPerWeek == null) reasons.push("Hours per week not recorded (STEM OPT requires at least 20).");
    else if (i.hoursPerWeek < 20) reasons.push("STEM OPT requires at least 20 hours per week.");
  }
  if (i.type === "OPT" && i.hoursPerWeek != null && i.hoursPerWeek < 20) {
    warnings.push("Post-completion OPT is typically expected to be at least 20 hours/week; confirm with DSO.");
  }

  return { cleared: reasons.length === 0, reasons, warnings };
}
