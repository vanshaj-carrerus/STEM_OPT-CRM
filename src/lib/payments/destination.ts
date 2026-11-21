/**
 * Destination/recipient safety. The CRM never stores a full account, routing or card number — only a masked
 * reference ("****1234", a bank nickname, a provider reference). Anything that looks like a full number is masked on
 * save, and anything that looks like a payment card (Luhn-valid 13–19 digits) is rejected outright.
 */

/** Luhn checksum over a digit-only string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// a run of digits, optionally split by single spaces or dashes
const DIGIT_RUN = /\d(?:[ -]?\d)*/g;

/** True if any digit run (spaces/dashes tolerated) is a Luhn-valid 13–19 digit number. */
export function containsCardNumber(text: string): boolean {
  for (const m of text.matchAll(DIGIT_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

/** True if 9 or more digits appear in a row (separators tolerated) — i.e. could be a full account/routing number. */
export function containsLongDigitRun(text: string): boolean {
  for (const m of text.matchAll(DIGIT_RUN)) {
    if (m[0].replace(/\D/g, "").length >= 9) return true;
  }
  return false;
}

const IBAN_LIKE = /\b([A-Z]{2})\d{2} ?(?:[A-Z0-9] ?){10,30}\b/g;

/** Replace anything that could be a full account number with a masked form ("****6819"). */
export function maskSensitiveNumbers(text: string): string {
  let out = text.replace(IBAN_LIKE, (match) => {
    const compact = match.replace(/\s/g, "");
    return `${compact.slice(0, 2)}** ****${compact.slice(-4)}`;
  });
  out = out.replace(DIGIT_RUN, (run) => {
    const digits = run.replace(/\D/g, "");
    return digits.length >= 9 ? `****${digits.slice(-4)}` : run;
  });
  return out;
}

export interface DestinationCheck {
  ok: boolean;
  masked: string;
  wasMasked: boolean;
  error?: string;
}

export const MAX_DESTINATION_LEN = 80;

export function validateDestinationReference(input: string | null | undefined): DestinationCheck {
  const raw = (input ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { ok: true, masked: "", wasMasked: false };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(raw)) return { ok: false, masked: "", wasMasked: false, error: "Destination reference contains invalid characters." };
  if (containsCardNumber(raw)) {
    return {
      ok: false,
      masked: "",
      wasMasked: false,
      error: "That looks like a card number. Never enter card numbers; use the last 4 digits only (e.g. ****1234).",
    };
  }
  const masked = maskSensitiveNumbers(raw);
  if (masked.length > MAX_DESTINATION_LEN) {
    return { ok: false, masked: "", wasMasked: false, error: `Destination reference must be ${MAX_DESTINATION_LEN} characters or fewer.` };
  }
  return { ok: true, masked, wasMasked: masked !== raw };
}

/** Provider/bank reference tokens (Ria transfer ID, bank reference, Gusto payroll ID). */
export function validateProviderReference(input: string | null | undefined): { ok: boolean; value: string; error?: string } {
  const v = (input ?? "").trim();
  if (!v) return { ok: false, value: "", error: "A provider/bank reference is required." };
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/:#]{3,63}$/.test(v)) {
    return { ok: false, value: v, error: "Reference must be 4–64 characters (letters, digits and . _ - / : #)." };
  }
  if (/^\d{13,19}$/.test(v) && luhnValid(v)) {
    return { ok: false, value: v, error: "That looks like a card number, not a transfer or bank reference." };
  }
  return { ok: true, value: v };
}

/** Free text (reason, notes, names) must not smuggle in a card number. */
export function cardNumberError(text: string | null | undefined, label: string): string | null {
  return text && containsCardNumber(text) ? `${label} must not contain card numbers.` : null;
}

export const normalizeText = (s: string | null | undefined) => (s ?? "").normalize("NFKD").replace(/\s+/g, " ").trim().toLowerCase();
