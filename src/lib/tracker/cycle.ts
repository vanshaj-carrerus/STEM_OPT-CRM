import { addMonths, isDateOnly, todayIn, type DateOnly } from "@/lib/compliance/dates";
import { DEFAULT_MONTHLY_CHECKLISTS, generateMonthlyReviews, type MonthlyReviewDraft } from "@/lib/compliance/milestones";

/**
 * Pure rules for the 12-month operational tracker (AC-07). It is an internal review aid configured by compliance;
 * it never replaces official DSO / SEVIS reporting and never auto-submits anything.
 */

/** Default anchor = authorization start when known, otherwise the compliance-onboarding (record creation) date. */
export function defaultAnchorFor(c: { eadStart?: string | null; createdAt: Date }, timezone: string): DateOnly {
  return c.eadStart && isDateOnly(c.eadStart) ? c.eadStart : todayIn(timezone, c.createdAt);
}

export interface CyclePlanInput {
  anchor: DateOnly;
  /** WHY this anchor was chosen. Always required and stored on the cycle. */
  anchorReason: string;
  /** The default anchor for the candidate; choosing a different one is a "custom anchor". */
  defaultAnchor: DateOnly;
  /** Overrides from setting `tracker.checklists`; missing months fall back to the built-in checklists. */
  checklists?: Record<number, string[]>;
}

export type CyclePlan =
  | { ok: true; anchorDate: DateOnly; anchorReason: string; customAnchor: boolean; reviews: MonthlyReviewDraft[] }
  | { ok: false; error: string };

export function planCycle(i: CyclePlanInput): CyclePlan {
  if (!isDateOnly(i.anchor)) return { ok: false, error: "Enter a valid anchor date." };
  const reason = i.anchorReason?.trim() ?? "";
  if (reason.length < 5) return { ok: false, error: "Record why this anchor date was chosen (at least 5 characters)." };
  return {
    ok: true,
    anchorDate: i.anchor,
    anchorReason: reason,
    customAnchor: i.anchor !== i.defaultAnchor,
    reviews: generateMonthlyReviews(i.anchor, { ...DEFAULT_MONTHLY_CHECKLISTS, ...(i.checklists ?? {}) }),
  };
}

export const monthlyRefKey = (cycleId: string, month: number) => `monthly:${cycleId}:${month}`;

/** Only ever advance month-by-month from the finished cycle's anchor so the next cycle continues the same calendar. */
export const nextCycleAnchor = (prevAnchor: DateOnly): DateOnly => addMonths(prevAnchor, 12);

const DONE = new Set(["completed", "waived"]);

export type CloseCheck = { ok: true } | { ok: false; error: string };

/**
 * A cycle closes only after a manager review (`tracker.signoff`) AND when all 12 months are finished
 * (completed or waived with a reason). Cancelled / open / waiting months block the close.
 */
export function canCloseCycle(p: { reviews: { monthNumber: number; status: string }[]; hasSignoffPermission: boolean; note?: string }): CloseCheck {
  if (!p.hasSignoffPermission) return { ok: false, error: "Only a manager with sign-off permission can close a cycle." };
  const months = new Set(p.reviews.filter((r) => DONE.has(r.status)).map((r) => r.monthNumber));
  const missing = Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => !months.has(m));
  if (missing.length) return { ok: false, error: `Months still open: ${missing.join(", ")}. Complete or waive them before closing.` };
  if (!p.note || p.note.trim().length < 3) return { ok: false, error: "Record the manager review note for this sign-off." };
  return { ok: true };
}

/** A new cycle starts automatically only when the setting says so; otherwise a manager must trigger it. */
export function mayStartNextCycle(p: { autoNextCycle: boolean; triggeredByManager: boolean; hasOpenCycle: boolean; hasClosedCycle: boolean }): boolean {
  if (p.hasOpenCycle) return false;
  if (!p.hasClosedCycle) return true; // first cycle
  return p.triggeredByManager || p.autoNextCycle;
}
