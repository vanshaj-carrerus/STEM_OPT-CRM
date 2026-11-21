/** Cell clean-up applied to every imported value before it is mapped or stored. */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** Looks like a legitimate phone/number ("+1 (555) 010-2000", "-5"), which may start with + or -. */
const NUMERICISH = /^[+-]?[\d\s().-]+$/;
const FORMULA_START = /^[=+\-@\t\r]+/;

export interface CleanCell {
  value: string;
  /** A leading spreadsheet-formula character was removed. */
  neutralized: boolean;
}

/**
 * Trim, drop control characters and neutralise spreadsheet-formula injection: a text cell starting with = + - @
 * (or tab/CR) would execute as a formula when the stored value is later exported to Excel, so those leading
 * characters are stripped. Numeric-looking values (phone numbers) are left intact; exports additionally escape
 * via csvEscape.
 */
export function cleanCell(raw: unknown): CleanCell {
  let s = raw === null || raw === undefined ? "" : String(raw);
  s = s.replace(CONTROL, "").replace(/\r?\n/g, " ").trim();
  if (FORMULA_START.test(s) && !NUMERICISH.test(s)) {
    s = s.replace(FORMULA_START, "").trim();
    return { value: s, neutralized: true };
  }
  return { value: s, neutralized: false };
}
