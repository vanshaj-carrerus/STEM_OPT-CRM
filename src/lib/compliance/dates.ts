/**
 * Date-only helpers. Immigration deadlines are calendar dates ("YYYY-MM-DD"), NOT instants, so they are
 * never converted through timezones (long spec §11: "keep date-only immigration deadlines as date fields").
 */
export type DateOnly = string; // "YYYY-MM-DD"

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateOnly(s: unknown): s is DateOnly {
  if (typeof s !== "string") return false;
  const m = RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function toUtc(s: DateOnly): Date {
  if (!isDateOnly(s)) throw new Error(`Invalid date-only value: ${s}`);
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): DateOnly {
  return d.toISOString().slice(0, 10);
}

export function addDays(s: DateOnly, days: number): DateOnly {
  const d = toUtc(s);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** Add calendar months, clamping to month end (Aug 31 + 6 months → Feb 28/29). */
export function addMonths(s: DateOnly, months: number): DateOnly {
  const d = toUtc(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return fromUtc(d);
}

export function diffDays(a: DateOnly, b: DateOnly): number {
  return Math.round((toUtc(a).getTime() - toUtc(b).getTime()) / 86_400_000);
}

export const compareDates = (a: DateOnly, b: DateOnly) => (a < b ? -1 : a > b ? 1 : 0);

/** Today's calendar date in an IANA timezone (school/record timezone), as date-only. */
export function todayIn(tz: string, now: Date = new Date()): DateOnly {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts; // en-CA yields YYYY-MM-DD
}

export function isBusinessDay(s: DateOnly, holidays: ReadonlySet<DateOnly> = new Set()): boolean {
  const dow = toUtc(s).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(s);
}

/** Number of business days strictly after `from` up to and including `to` (0 if to <= from). */
export function businessDaysBetween(from: DateOnly, to: DateOnly, holidays: ReadonlySet<DateOnly> = new Set()): number {
  if (compareDates(to, from) <= 0) return 0;
  let n = 0;
  for (let d = addDays(from, 1); compareDates(d, to) <= 0; d = addDays(d, 1)) {
    if (isBusinessDay(d, holidays)) n++;
  }
  return n;
}

export function formatDate(s: DateOnly | null | undefined): string {
  if (!s) return "—";
  const d = toUtc(s);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
