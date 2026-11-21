/**
 * Candidate enums & labels. Deliberately free of any database/server imports so it is safe to use in
 * client components (importing the Mongoose model from the browser bundle breaks the build).
 */
export const CANDIDATE_STAGES = ["new", "onboarding", "active", "on_hold", "offboarded", "archived"] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];
export const STAGE_LABELS: Record<CandidateStage, string> = {
  new: "New",
  onboarding: "Onboarding",
  active: "Active",
  on_hold: "On Hold",
  offboarded: "Offboarded",
  archived: "Archived",
};

export const AUTH_TYPES = ["none", "CPT", "OPT", "STEM_OPT"] as const;
export type CandidateAuthType = (typeof AUTH_TYPES)[number];
export const AUTH_TYPE_LABELS: Record<CandidateAuthType, string> = {
  none: "Not set",
  CPT: "CPT",
  OPT: "OPT",
  STEM_OPT: "STEM OPT",
};

export const I983_STATUSES = ["not_applicable", "not_started", "draft", "awaiting_signatures", "signed", "submitted_to_dso", "needs_update"] as const;
