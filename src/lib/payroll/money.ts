/**
 * Money helpers. Amounts are ALWAYS integer minor units (cents) + a currency code — never floats.
 */
export const DEFAULT_CURRENCY = "USD";

/**
 * Parse a user/CSV money string into integer cents without any floating point arithmetic.
 * Accepts "1234.5", "$1,234.56", "-12", "(12.30)" (accounting negative). Returns null for blank or invalid input
 * (including more than 2 decimal places, which would silently lose precision).
 */
export function parseMoneyToCents(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^\$/, "").replace(/^-\s*\$/, "-").replace(/,/g, "").trim();
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** Format integer cents for display, e.g. 123456 → "$1,234.56". */
export function formatCents(cents: number | null | undefined, currency = DEFAULT_CURRENCY): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "—";
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  const sign = cents < 0 ? "-" : "";
  const symbol = currency === "USD" ? "$" : "";
  return `${sign}${symbol}${whole}.${frac}${symbol ? "" : ` ${currency}`}`;
}

/** Render cents as a plain "1234.56" string (for form inputs). */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const abs = Math.abs(Math.trunc(cents));
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
