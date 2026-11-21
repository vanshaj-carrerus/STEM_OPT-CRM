import { makeSchema, model } from "../base";
import { DOCUMENT_CATEGORIES, VERIFICATION_STATES, type DocumentCategory, type VerificationState } from "@/lib/documents/types";

/**
 * One row per document VERSION. Re-uploading creates a new row in the same `groupId` (version+1) and flips
 * `isLatest`; old versions and their files are retained (never overwritten or deleted).
 */
export interface IDocument {
  _id: string;
  candidateId: string;
  groupId: string; // shared by all versions of the same logical document
  version: number;
  isLatest: boolean;
  category: DocumentCategory;
  type: string; // key from DOCUMENT_TYPES
  title?: string;
  employerId?: string | null; // e.g. offer letter / CPT I-20 for a specific employer
  objectKey: string; // storage key (server generated)
  fileName: string; // display only
  contentType: string;
  sizeBytes: number;
  sha256: string;
  issueDate?: string; // date-only
  expiryDate?: string; // date-only
  verification: VerificationState;
  reviewerId?: string | null;
  reviewedAt?: Date | null;
  reviewNote?: string;
  restricted: boolean; // requires sensitive.tax.view
  scan: { ok: boolean; engine: string };
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = makeSchema<IDocument>({
  candidateId: { type: String, required: true, index: true },
  groupId: { type: String, required: true },
  version: { type: Number, required: true, default: 1 },
  isLatest: { type: Boolean, default: true },
  category: { type: String, enum: DOCUMENT_CATEGORIES, required: true },
  type: { type: String, required: true },
  title: String,
  employerId: { type: String, default: null },
  objectKey: { type: String, required: true },
  fileName: { type: String, required: true },
  contentType: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
  sha256: { type: String, required: true },
  issueDate: String,
  expiryDate: { type: String, index: true },
  verification: { type: String, enum: VERIFICATION_STATES, default: "pending_review", index: true },
  reviewerId: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: String,
  restricted: { type: Boolean, default: false },
  scan: { ok: Boolean, engine: String },
  uploadedBy: { type: String, required: true },
});
schema.index({ groupId: 1, version: 1 }, { unique: true });
schema.index({ candidateId: 1, isLatest: 1, type: 1 });

export const DocumentModel = model<IDocument>("Document", schema, "documents");
