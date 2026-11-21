/**
 * Money helpers for the payment ledger. Amounts are ALWAYS integer minor units (cents) + ISO currency code.
 * FX rates are decimal strings. Conversion uses BigInt integer math with half-up rounding — never floats.
 */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "UGX", "XOF", "XAF", "PYG", "RWF", "ISK"]);
const THREE_DECIMAL = new Set(["BHD", "KWD", "JOD", "OMR", "TND"]);

export const CURRENCY_RE = /^[A-Z]{3}$/;
export const COMMON_CURRENCIES = ["USD", "INR", "EUR", "GBP", "CAD", "AUD", "MXN", "PHP", "NGN", "BRL", "CNY", "NPR", "PKR", "BDT", "LKR", "VND"] as const;

/** Largest amount accepted in minor units (keeps every value a safe integer). */
export const MAX_MINOR = 1_000_000_000_000;
export const FX_SCALE = 8; // max decimal places in a quoted rate

export function currencyExponent(currency: string): number {
  const c = currency.toUpperCase();
  return ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2;
}

export function assertCurrency(currency: string): string {
  const c = (currency ?? "").trim().toUpperCase();
  if (!CURRENCY_RE.test(c)) throw new MoneyError("Currency must be a 3-letter ISO code (e.g. USD)");
  return c;
}

/** "1,234.50" → 123450 (USD). Rejects negatives, exponent notation and too many decimals for the currency. */
export function parseAmountToMinor(input: string | number, currency: string): number {
  const cur = assertCurrency(currency);
  const exp = currencyExponent(cur);
  const s = String(input).trim().replace(/,/g, "");
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(s);
  if (!m) throw new MoneyError("Enter a valid non-negative amount (digits and an optional decimal point)");
  const frac = m[2] ?? "";
  if (frac.length > exp) throw new MoneyError(`${cur} allows at most ${exp} decimal place${exp === 1 ? "" : "s"}`);
  const minor = BigInt(m[1]) * 10n ** BigInt(exp) + BigInt(frac.padEnd(exp, "0") || "0");
  if (minor > BigInt(MAX_MINOR)) throw new MoneyError("Amount is too large");
  return Number(minor);
}

/** Like parseAmountToMinor but accepts a leading "+" or "-" (used for signed ledger corrections). */
export function parseSignedAmountToMinor(input: string | number, currency: string): number {
  const s = String(input).trim();
  const neg = s.startsWith("-");
  const minor = parseAmountToMinor(s.replace(/^[+-]/, ""), currency);
  return neg ? -minor : minor;
}

/** Canonical decimal text for a rate ("83.2500" → "83.25"). */
export function normalizeRate(input: string | number): string {
  const s = String(input).trim();
  const m = /^(\d{1,10})(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) throw new MoneyError(`FX rate must be a positive decimal with at most ${FX_SCALE} decimal places`);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  const int = m[1].replace(/^0+(?=\d)/, "");
  if (/^0*$/.test(int) && frac === "") throw new MoneyError("FX rate must be greater than zero");
  return frac ? `${int}.${frac}` : int;
}

/** converted = amount × rate, in the destination currency's minor units, rounded half-up. */
export function convertMinor(amountMinor: number, fromCurrency: string, toCurrency: string, rate: string): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new MoneyError("Amount must be a non-negative integer of minor units");
  const r = normalizeRate(rate);
  const [i, f = ""] = r.split(".");
  const scaled = BigInt(i + f.padEnd(FX_SCALE, "0"));
  const num = BigInt(amountMinor) * scaled * 10n ** BigInt(currencyExponent(toCurrency));
  const den = 10n ** BigInt(currencyExponent(fromCurrency) + FX_SCALE);
  const out = (num * 2n + den) / (2n * den); // half-up
  if (out > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError("Converted amount is too large");
  return Number(out);
}

/** Exact decimal string with no grouping, e.g. 123450 USD → "1234.50" (CSV / APIs). */
export function formatMinorPlain(minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  const neg = minor < 0;
  const abs = BigInt(Math.abs(minor));
  const digits = abs.toString().padStart(exp + 1, "0");
  const int = digits.slice(0, digits.length - exp);
  const frac = exp ? "." + digits.slice(digits.length - exp) : "";
  return `${neg ? "-" : ""}${int}${frac}`;
}

/** Display string with thousands separators, e.g. "1,234.50 USD". */
export function formatMinor(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return "—";
  const plain = formatMinorPlain(minor, currency);
  const neg = plain.startsWith("-");
  const [int, frac] = plain.replace("-", "").split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac ? "." + frac : ""} ${currency}`;
}

/** Major-unit number for the pure rules engines (which take major units) and display only. */
export function minorToMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency);
}
