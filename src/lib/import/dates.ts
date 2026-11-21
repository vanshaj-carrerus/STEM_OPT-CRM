import { isDateOnly } from "@/lib/compliance/dates";

export type DateResult = { value?: string; error?: string };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

function build(y: number, m: number, d: number): DateResult {
  const s = `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
  return y >= 1900 && y <= 2200 && isDateOnly(s) ? { value: s } : { error: "Not a valid calendar date" };
}

/** Two-digit years: 00–69 → 2000s, 70–99 → 1900s (roster dates are DOBs and recent authorization dates). */
const expandYear = (yy: number) => (yy < 70 ? 2000 + yy : 1900 + yy);

/** Excel's 1900 date system (with its fictitious 1900-02-29): serial 25569 = 1970-01-01. */
export function excelSerialToDate(serial: number): DateResult {
  if (!Number.isFinite(serial) || serial < 10000 || serial > 73050) return { error: "Not a valid Excel date serial" };
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  return build(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Normalise a spreadsheet/CSV date cell to "YYYY-MM-DD" (no timezone conversion — these are calendar dates).
 * Accepts: ISO (2026-03-05, with optional time), YYYY/MM/DD, M/D/YYYY and M-D-YYYY (US order; if the first number
 * is > 12 it is read as day-first), M/D/YY, YYYYMMDD, "Mar 5, 2026" / "5 March 2026", Excel serial numbers, and
 * JS Date objects (read in UTC, which is how exceljs delivers date cells).
 */
export function normalizeDate(input: unknown): DateResult {
  if (input === null || input === undefined) return {};
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? { error: "Not a valid date" } : build(input.getUTCFullYear(), input.getUTCMonth() + 1, input.getUTCDate());
  }
  if (typeof input === "number") return excelSerialToDate(input);
  const s = String(input).trim();
  if (!s) return {};

  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s))) return build(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s))) return build(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return build(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s))) {
    let a = +m[1];
    let b = +m[2];
    const y = m[3].length === 2 ? expandYear(+m[3]) : +m[3];
    if (a > 12 && b <= 12) [a, b] = [b, a]; // clearly day-first (e.g. 25/12/2025)
    return build(y, a, b);
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) {
    const mon = MONTHS[m[1].toLowerCase()];
    return mon ? build(+m[3], mon, +m[2]) : { error: "Unrecognised month name" };
  }
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})$/.exec(s))) {
    const mon = MONTHS[m[2].toLowerCase()];
    return mon ? build(+m[3], mon, +m[1]) : { error: "Unrecognised month name" };
  }
  // Excel serial that survived as text (5 digits ≈ 1927–2099; avoids mistaking small numbers like "12" for dates)
  if (/^\d{5}(\.\d+)?$/.test(s)) return excelSerialToDate(Math.floor(Number(s)));
  return { error: `Unrecognised date "${s.slice(0, 30)}" (use YYYY-MM-DD or M/D/YYYY)` };
}
