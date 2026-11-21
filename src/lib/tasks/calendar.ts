import { addDays, addMonths, compareDates, type DateOnly } from "@/lib/compliance/dates";

/** Pure helpers behind the compliance calendar (month / week / list views). Dates are date-only strings, never timezone-converted. */

export type CalendarView = "month" | "week" | "list";

export interface CalendarEntry {
  id: string;
  date: DateOnly;
  title: string;
  kind: string; // milestone | monthly_review | manual | ...
  status: string;
  overdue: boolean;
  candidateId: string | null;
  candidateName?: string;
}

/** Day of week (0 = Sunday) for a date-only value, computed in UTC so no timezone shift is possible. */
export function dayOfWeek(d: DateOnly): number {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).getUTCDay();
}

export function startOfWeek(d: DateOnly): DateOnly {
  return addDays(d, -dayOfWeek(d)); // weeks start on Sunday
}

export const firstOfMonth = (d: DateOnly): DateOnly => `${d.slice(0, 7)}-01`;

/** Weeks (arrays of 7 dates) covering the month of `anchor`, Sunday-first, padded with adjacent-month days. */
export function monthGrid(anchor: DateOnly): DateOnly[][] {
  const first = firstOfMonth(anchor);
  const last = addDays(addMonths(first, 1), -1);
  const weeks: DateOnly[][] = [];
  let cur = startOfWeek(first);
  while (compareDates(cur, last) <= 0) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cur, i)));
    cur = addDays(cur, 7);
  }
  return weeks;
}

export function weekDates(anchor: DateOnly): DateOnly[] {
  const s = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}

/** Date range to query for a view around an anchor date. List view = the anchor's month. */
export function rangeForView(view: CalendarView, anchor: DateOnly): { from: DateOnly; to: DateOnly } {
  if (view === "week") {
    const w = weekDates(anchor);
    return { from: w[0], to: w[6] };
  }
  if (view === "month") {
    const g = monthGrid(anchor);
    return { from: g[0][0], to: g[g.length - 1][6] };
  }
  const first = firstOfMonth(anchor);
  return { from: first, to: addDays(addMonths(first, 1), -1) };
}

/** Previous / next anchor for navigation. */
export function shiftAnchor(view: CalendarView, anchor: DateOnly, dir: -1 | 1): DateOnly {
  return view === "week" ? addDays(anchor, 7 * dir) : addMonths(firstOfMonth(anchor), dir);
}

/** Group entries by date; each day's list is ordered overdue-first, then by title (stable and deterministic). */
export function groupByDate(entries: CalendarEntry[]): Map<DateOnly, CalendarEntry[]> {
  const map = new Map<DateOnly, CalendarEntry[]>();
  for (const e of entries) {
    const list = map.get(e.date);
    if (list) list.push(e);
    else map.set(e.date, [e]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }
  return new Map([...map.entries()].sort((a, b) => compareDates(a[0], b[0])));
}

export const isOverdue = (status: string, dueDate: DateOnly, today: DateOnly) =>
  ["open", "in_progress", "waiting_candidate", "waiting_employer", "waiting_dso"].includes(status) && compareDates(dueDate, today) < 0;
