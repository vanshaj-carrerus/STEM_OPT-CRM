import { addDays, addMonths, compareDates, type DateOnly } from "./dates";

/**
 * Milestone + 12-month review generation (long spec §3, §5; AC-04/05/07).
 * These are INTERNAL operational due dates. They do not replace official DSO/SEVIS reporting windows,
 * and nothing here decides legal eligibility or auto-submits anything.
 */

export type MilestoneType =
  | "stem_validation_6m"
  | "stem_evaluation_12m" // validation + I-983 Evaluation on Student Progress
  | "stem_validation_18m"
  | "stem_final_evaluation_24m" // validation + Final Evaluation, end of training
  | "authorization_expiry_90d"
  | "authorization_expiry_60d"
  | "authorization_expiry_30d";

export interface MilestoneDraft {
  type: MilestoneType;
  title: string;
  anchorDate: DateOnly;
  dueDate: DateOnly;
  checklist: string[];
  note: string;
}

const DSO_NOTE =
  "Internal reminder only. Confirm the official reporting window and submission procedure with the student's DSO / immigration counsel.";

/** STEM milestones anchored to the STEM EAD start date (6/12/18/24 months). Requires a VERIFIED start date. */
export function generateStemMilestones(stemEadStart: DateOnly, stemEadEnd?: DateOnly | null): MilestoneDraft[] {
  const m = (n: number) => addMonths(stemEadStart, n);
  const finalDue = stemEadEnd && compareDates(stemEadEnd, m(24)) < 0 ? stemEadEnd : m(24);
  return [
    {
      type: "stem_validation_6m",
      title: "6-month STEM OPT validation",
      anchorDate: stemEadStart,
      dueDate: m(6),
      checklist: ["Confirm legal name", "Confirm residential/mailing address", "Confirm employer name and address", "Confirm employment status", "Record submission evidence"],
      note: DSO_NOTE,
    },
    {
      type: "stem_evaluation_12m",
      title: "12-month validation + I-983 Evaluation on Student Progress",
      anchorDate: stemEadStart,
      dueDate: m(12),
      checklist: ["12-month validation (name, address, employer, status)", "Evaluation on Student Progress completed", "Student section signed", "Employer section signed", "Submitted to DSO; evidence uploaded"],
      note: DSO_NOTE,
    },
    {
      type: "stem_validation_18m",
      title: "18-month STEM OPT validation",
      anchorDate: stemEadStart,
      dueDate: m(18),
      checklist: ["Confirm current personal and employer details", "Record submission evidence"],
      note: DSO_NOTE,
    },
    {
      type: "stem_final_evaluation_24m",
      title: "24-month validation + Final Evaluation (end of training)",
      anchorDate: stemEadStart,
      dueDate: finalDue,
      checklist: ["Capture end-of-training date", "Final Evaluation on Student Progress completed", "Signed by student and employer", "Submitted to DSO; evidence uploaded"],
      note: DSO_NOTE,
    },
  ];
}

/** Authorization-expiry warnings at 90/60/30 days before the end date (dashboard KPI, long spec §15). */
export function generateExpiryMilestones(authEnd: DateOnly): MilestoneDraft[] {
  return ([90, 60, 30] as const).map((d) => ({
    type: `authorization_expiry_${d}d` as MilestoneType,
    title: `Authorization expires in ${d} days`,
    anchorDate: authEnd,
    dueDate: addDays(authEnd, -d),
    checklist: ["Confirm next steps with candidate", "Confirm with DSO/counsel (extension, STEM, change of status)", "Update employment plan"],
    note: DSO_NOTE,
  }));
}

/** Default monthly review checklist (long spec §5). Admin can override via settings. */
export const DEFAULT_MONTHLY_CHECKLISTS: Record<number, string[]> = {
  1: ["Profile completeness", "Authorization evidence on file", "Employer/client mapping", "Payroll setup", "First-week check-in"],
  2: ["Confirm employment active", "Role/duties and worksite unchanged", "Payroll/payment exceptions reviewed"],
  3: ["Document expiry scan", "Contact details current", "Missing evidence chased", "Candidate check-in"],
  4: ["Employment status and hours check", "Payroll reconciliation", "Open issues reviewed"],
  5: ["Upcoming school/DSO reporting check", "I-20/EAD validated", "Employer data validated"],
  6: ["Formal six-month review", "Confirm required STEM validation (if applicable)", "Record submission evidence"],
  7: ["Review changes since last checkpoint", "Employer, address, role, worksite and hours"],
  8: ["Payroll exception review", "Payment reconciliation", "Document refresh"],
  9: ["Authorization expiration forecast", "Next milestone readiness"],
  10: ["Review candidate/employer details", "Training plan changes", "Raise DSO review tasks if needed"],
  11: ["Prepare next annual/authorization milestone", "Chase missing signatures/documents"],
  12: ["Annual operational review", "STEM I-983 evaluation task (if applicable)", "Manager sign-off", "Next-cycle decision"],
};

export interface MonthlyReviewDraft {
  monthNumber: number;
  dueDate: DateOnly;
  checklist: { label: string; done: boolean }[];
}

/** Month 1–12 review tasks from the chosen anchor (start date or onboarding date). Month N is due N months after anchor. */
export function generateMonthlyReviews(
  anchor: DateOnly,
  checklists: Record<number, string[]> = DEFAULT_MONTHLY_CHECKLISTS,
): MonthlyReviewDraft[] {
  return Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return {
      monthNumber: n,
      dueDate: addMonths(anchor, n),
      checklist: (checklists[n] ?? DEFAULT_MONTHLY_CHECKLISTS[n]).map((label) => ({ label, done: false })),
    };
  });
}

/** CPT: a year or more of full-time CPT at the same education level may eliminate OPT eligibility → flag, never conclude. */
export interface CptSegment {
  start: DateOnly;
  end: DateOnly;
  fullTime: boolean;
  educationLevel: string;
}

export function fullTimeCptReviewFlag(segments: CptSegment[]): { flag: boolean; days: number; message?: string } {
  const byLevel = new Map<string, number>();
  for (const s of segments) {
    if (!s.fullTime) continue;
    const days = Math.max(0, Math.round((Date.parse(s.end) - Date.parse(s.start)) / 86_400_000) + 1);
    byLevel.set(s.educationLevel, (byLevel.get(s.educationLevel) ?? 0) + days);
  }
  const max = Math.max(0, ...byLevel.values());
  // 12 months ≈ 365 days of cumulative full-time CPT
  if (max >= 365) {
    return {
      flag: true,
      days: max,
      message:
        "Cumulative full-time CPT of 12 months or more at the same education level. Flag for DSO/legal review — this is not an automatic legal conclusion.",
    };
  }
  return { flag: false, days: max };
}
