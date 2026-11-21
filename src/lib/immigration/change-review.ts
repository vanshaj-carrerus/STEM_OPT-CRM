import { createHash } from "node:crypto";

export type MaterialChangeFieldKey = "employer" | "address" | "hours" | "compensation" | "trainingPlan" | "jobDuties" | "worksite";

/** Same-day duplicate triggers for the same change collapse onto one task (idempotent upsert key). */
export const changeReviewRefKey = (fields: MaterialChangeFieldKey[], isoDate: string, summary: string) =>
  `change:${[...new Set(fields)].sort().join("+")}:${isoDate}:${createHash("sha1").update(summary.trim().toLowerCase()).digest("hex").slice(0, 8)}`;
