export const DEFAULT_TIMEZONE = "America/New_York";

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The timezone whose calendar date counts as "today" for a record's reminders:
 * the candidate record's timezone, else the owner's profile timezone, else America/New_York.
 * (Deadlines are date-only; only "today" depends on a timezone. Timestamps are always stored in UTC.)
 */
export function resolveTimezone(candidateTz?: string | null, ownerTz?: string | null, fallback = DEFAULT_TIMEZONE): string {
  if (isValidTimezone(candidateTz)) return candidateTz;
  if (isValidTimezone(ownerTz)) return ownerTz;
  return fallback;
}
