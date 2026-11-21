/**
 * Pure document-vault rules (no DB / no I/O) so they can be unit-tested and reused by the service, the UI
 * and other modules. See service.ts for the persistence side.
 */
import { compareDates, diffDays, type DateOnly } from "@/lib/compliance/dates";
import { SeparationOfDutiesError } from "@/lib/sod";
import type { Role } from "@/lib/rbac/permissions";
import { DOCUMENT_TYPE_MAP, REQUIRED_DOCS, type VerificationState } from "./types";

/** Minimal document shape the rules need. */
export interface RuleDoc {
  type: string;
  isLatest: boolean;
  verification: VerificationState;
  expiryDate?: string | null;
}

/** Whether a document type is restricted (needs `sensitive.tax.view` on top of the documents.* permissions). */
export function isRestrictedType(type: string): boolean {
  const def = DOCUMENT_TYPE_MAP[type];
  return !!def && (def.restricted === true || def.category === "payroll_tax");
}

/* ------------------------------- versioning ------------------------------- */

/** Next version number for a logical document (group). Versions are 1-based and strictly increasing. */
export function nextVersion(existingVersions: readonly number[]): number {
  return existingVersions.length ? Math.max(...existingVersions) + 1 : 1;
}

/* -------------------------------- expiry -------------------------------- */

/** A document is valid THROUGH its expiry date; it is expired from the day after. */
export function isExpired(expiryDate: string | null | undefined, today: DateOnly): boolean {
  return !!expiryDate && compareDates(expiryDate, today) < 0;
}

/** Days until expiry (negative once expired); null when no expiry is recorded. */
export function daysUntilExpiry(expiryDate: string | null | undefined, today: DateOnly): number | null {
  return expiryDate ? diffDays(expiryDate, today) : null;
}

export type DisplayStatus = VerificationState | "expired";

/** Status chip: an expired (non-rejected) document is shown as expired regardless of its review state. */
export function displayStatus(d: Pick<RuleDoc, "verification" | "expiryDate">, today: DateOnly): DisplayStatus {
  if (d.verification !== "rejected" && isExpired(d.expiryDate, today)) return "expired";
  return d.verification;
}

/** True when the document can serve as evidence: latest version, verified, and not expired. */
export function satisfiesRequirement(d: RuleDoc, today: DateOnly): boolean {
  return d.isLatest && d.verification === "verified" && !isExpired(d.expiryDate, today);
}

/* ---------------------------- required-doc checklist ---------------------------- */

export type MissingReason = "not_uploaded" | "pending_review" | "rejected" | "expired";

export interface MissingDocument {
  type: string;
  label: string;
  reason: MissingReason;
}

/**
 * Required document types NOT currently satisfied. A required type is satisfied only by a latest-version,
 * verified, non-expired document. For unsatisfied types the reason reports the most helpful state found
 * (pending review beats expired beats rejected beats nothing uploaded).
 */
export function computeMissing(
  authType: keyof typeof REQUIRED_DOCS | string | null | undefined,
  docs: readonly RuleDoc[],
  today: DateOnly,
  required?: readonly string[],
): MissingDocument[] {
  const list = required ?? REQUIRED_DOCS[(authType as keyof typeof REQUIRED_DOCS) ?? "none"] ?? REQUIRED_DOCS.none;
  const out: MissingDocument[] = [];
  for (const type of list) {
    const latest = docs.filter((d) => d.type === type && d.isLatest);
    if (latest.some((d) => satisfiesRequirement(d, today))) continue;
    let reason: MissingReason = "not_uploaded";
    if (latest.some((d) => d.verification === "pending_review" && !isExpired(d.expiryDate, today))) reason = "pending_review";
    else if (latest.some((d) => d.verification === "verified" && isExpired(d.expiryDate, today))) reason = "expired";
    else if (latest.some((d) => d.verification === "rejected")) reason = "rejected";
    else if (latest.length) reason = "expired"; // pending but already expired
    out.push({ type, label: DOCUMENT_TYPE_MAP[type]?.label ?? type, reason });
  }
  return out;
}

export const MISSING_REASON_LABELS: Record<MissingReason, string> = {
  not_uploaded: "Not uploaded",
  pending_review: "Awaiting review",
  rejected: "Rejected — re-upload needed",
  expired: "Expired",
};

/* ----------------------------- verification flow ----------------------------- */

/** pending_review → verified | rejected. A new version resets to pending_review (see service.uploadDocument). */
export const REVIEW_TRANSITIONS: Record<VerificationState, readonly VerificationState[]> = {
  pending_review: ["verified", "rejected"],
  verified: [],
  rejected: [],
};

export type ReviewDecision = "verified" | "rejected";

/** Returns a user-facing error message, or null when the review is allowed. */
export function validateReview(input: {
  from: VerificationState;
  decision: ReviewDecision;
  note?: string | null;
  isLatest: boolean;
  expiryDate?: string | null;
  today: DateOnly;
}): string | null {
  if (!input.isLatest) return "Only the latest version of a document can be reviewed.";
  if (!REVIEW_TRANSITIONS[input.from].includes(input.decision)) {
    return input.from === "pending_review"
      ? "Invalid review decision."
      : "This version has already been reviewed. Upload a new version to start another review.";
  }
  if (input.decision === "rejected" && (input.note ?? "").trim().length < 3) return "A note is required when rejecting a document.";
  if (input.decision === "verified" && isExpired(input.expiryDate, input.today)) {
    return "This document is already past its expiry date and cannot be verified. Upload a current version.";
  }
  return null;
}

/** Roles allowed to review a version they uploaded themselves. Everyone else needs a second pair of eyes. */
export const SELF_REVIEW_ROLES: readonly Role[] = ["compliance_manager", "super_admin"];

/**
 * Reviewer separation: the reviewer must not be the uploader of the version under review, unless they hold a
 * manager-level role. Throws SeparationOfDutiesError (mapped to HTTP 403 by `route()`).
 */
export function assertReviewerAllowed(reviewerId: string, reviewerRole: Role, uploadedBy: string): void {
  if (reviewerId === uploadedBy && !SELF_REVIEW_ROLES.includes(reviewerRole)) {
    throw new SeparationOfDutiesError("You uploaded this document, so a different reviewer must verify or reject it.");
  }
}

/* ------------------------------ file handling ------------------------------ */

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Content type derived from the (scan-validated) extension — never trusted from the client. */
export function contentTypeFor(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

/** Only these may be rendered inline (preview); everything else is always a forced download. */
export const INLINE_PREVIEW_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export const canPreviewInline = (contentType: string) => (INLINE_PREVIEW_TYPES as readonly string[]).includes(contentType);

/** Content-Disposition value with an ASCII fallback plus RFC 5987 UTF-8 name (no header injection possible). */
export function contentDisposition(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
