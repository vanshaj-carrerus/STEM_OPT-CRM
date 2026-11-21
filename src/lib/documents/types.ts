/** Document taxonomy shared by the vault, immigration evidence and checklists. Add types here (additive only). */
export const DOCUMENT_CATEGORIES = ["immigration", "employment", "education", "payroll_tax", "other"] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  immigration: "Immigration",
  employment: "Employment",
  education: "Education",
  payroll_tax: "Payroll & tax (restricted)",
  other: "Other",
};

export interface DocumentTypeDef {
  key: string;
  label: string;
  category: DocumentCategory;
  /** Has an expiry date that should be tracked (drives expiring-document alerts). */
  expires?: boolean;
  /** Viewing requires `sensitive.tax.view` in addition to documents.view. */
  restricted?: boolean;
}

export const DOCUMENT_TYPES: DocumentTypeDef[] = [
  { key: "passport", label: "Passport (bio page)", category: "immigration", expires: true },
  { key: "visa", label: "F-1 visa", category: "immigration", expires: true },
  { key: "i94", label: "I-94 record", category: "immigration" },
  { key: "i20", label: "I-20 (incl. CPT / OPT endorsement)", category: "immigration", expires: true },
  { key: "ead_card", label: "EAD card", category: "immigration", expires: true },
  { key: "i983", label: "Form I-983 (training plan)", category: "immigration" },
  { key: "i983_evaluation", label: "I-983 evaluation (12 / 24-month)", category: "immigration" },
  { key: "dso_letter", label: "DSO letter / confirmation", category: "immigration" },
  { key: "validation_receipt", label: "STEM validation submission evidence", category: "immigration" },
  { key: "offer_letter", label: "Offer letter", category: "employment" },
  { key: "employment_verification", label: "Employment verification", category: "employment" },
  { key: "job_description", label: "Job description / duties", category: "employment" },
  { key: "everify_confirmation", label: "E-Verify confirmation", category: "employment" },
  { key: "resume", label: "Resume", category: "employment" },
  { key: "transcript", label: "Transcript / degree evidence", category: "education" },
  { key: "w4", label: "Tax withholding form", category: "payroll_tax", restricted: true },
  { key: "payroll_record", label: "Payroll record / pay statement", category: "payroll_tax", restricted: true },
  { key: "other", label: "Other", category: "other" },
];

export const DOCUMENT_TYPE_MAP = Object.fromEntries(DOCUMENT_TYPES.map((t) => [t.key, t]));

export const VERIFICATION_STATES = ["pending_review", "verified", "rejected"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

/** Types whose verified presence is required, by authorization type (the checklist). Admin-configurable later. */
export const REQUIRED_DOCS: Record<"none" | "CPT" | "OPT" | "STEM_OPT", string[]> = {
  none: ["passport", "resume"],
  CPT: ["passport", "i20", "offer_letter", "job_description"],
  OPT: ["passport", "i20", "ead_card", "offer_letter"],
  STEM_OPT: ["passport", "i20", "ead_card", "i983", "everify_confirmation", "offer_letter"],
};
