import { addDays, compareDates, diffDays, type DateOnly } from "@/lib/compliance/dates";

/**
 * Unemployment-day math from MANUALLY recorded periods. Commonly cited limits (90 days post-completion OPT,
 * 150 days including the STEM extension) are informational only — always confirm with the DSO.
 */
export const OPT_UNEMPLOYMENT_LIMIT = 90;
export const STEM_UNEMPLOYMENT_LIMIT = 150;
export const UNEMPLOYMENT_WARN_FRACTION = 0.8;

export interface UnemploymentSpan {
  startDate: DateOnly;
  /** null / undefined = still unemployed as of `asOf`. */
  endDate?: DateOnly | null;
}

/** Clip spans to `asOf`, merge overlapping/adjacent ones and return inclusive-day ranges. */
export function mergeUnemployment(spans: UnemploymentSpan[], asOf: DateOnly): { start: DateOnly; end: DateOnly }[] {
  const clipped = spans
    .map((s) => ({ start: s.startDate, end: s.endDate && compareDates(s.endDate, asOf) < 0 ? s.endDate : asOf }))
    .filter((s) => compareDates(s.start, s.end) <= 0)
    .sort((a, b) => compareDates(a.start, b.start));
  const merged: { start: DateOnly; end: DateOnly }[] = [];
  for (const s of clipped) {
    const last = merged[merged.length - 1];
    if (last && compareDates(s.start, addDays(last.end, 1)) <= 0) {
      if (compareDates(s.end, last.end) > 0) last.end = s.end;
    } else merged.push({ ...s });
  }
  return merged;
}

/** Total unemployed days (inclusive of both ends, overlaps counted once). */
export function totalUnemploymentDays(spans: UnemploymentSpan[], asOf: DateOnly): number {
  return mergeUnemployment(spans, asOf).reduce((n, r) => n + diffDays(r.end, r.start) + 1, 0);
}

export type UnemploymentLevel = "ok" | "approaching" | "at_limit";

export interface UnemploymentStatus {
  totalDays: number;
  limit: number;
  remaining: number;
  level: UnemploymentLevel;
  label: string;
}

export function unemploymentLimitFor(authType?: string | null): number {
  return authType === "STEM_OPT" ? STEM_UNEMPLOYMENT_LIMIT : OPT_UNEMPLOYMENT_LIMIT;
}

export function unemploymentStatus(totalDays: number, authType?: string | null): UnemploymentStatus {
  const limit = unemploymentLimitFor(authType);
  const level: UnemploymentLevel = totalDays >= limit ? "at_limit" : totalDays >= Math.floor(limit * UNEMPLOYMENT_WARN_FRACTION) ? "approaching" : "ok";
  const scope = limit === STEM_UNEMPLOYMENT_LIMIT ? "150 days including the STEM extension" : "90 days of OPT";
  const label =
    level === "ok"
      ? `Commonly cited limit: ${scope}. Confirm with DSO.`
      : level === "approaching"
        ? `Approaching the commonly cited limit of ${scope}. Confirm with DSO.`
        : `At or over the commonly cited limit of ${scope}. Confirm with DSO.`;
  return { totalDays, limit, remaining: Math.max(0, limit - totalDays), level, label };
}
