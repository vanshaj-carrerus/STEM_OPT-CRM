import { addDays, isBusinessDay, todayIn, type DateOnly } from "@/lib/compliance/dates";

/** Timezone used for "today" when no actor/school timezone is available (worker, API without a session). */
export const DEFAULT_TIMEZONE = "America/New_York";

export function todayFor(actor?: { timezone?: string } | null, now: Date = new Date()): DateOnly {
  return todayIn(actor?.timezone || DEFAULT_TIMEZONE, now);
}

/** `n` business days after `from` (weekends and listed holidays skipped). n=0 returns `from`. */
export function addBusinessDays(from: DateOnly, n: number, holidays: ReadonlySet<DateOnly> = new Set()): DateOnly {
  let d = from;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isBusinessDay(d, holidays)) left--;
  }
  return d;
}
