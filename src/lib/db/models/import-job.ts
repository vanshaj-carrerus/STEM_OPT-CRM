import { makeSchema, model } from "../base";

export const IMPORT_STATUSES = ["previewed", "committed", "cancelled"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export interface IImportOutcome {
  row: number;
  /** created | skipped_* | failed — never contains personal values. */
  status: string;
  candidateId?: string;
  candidateCode?: string;
  message?: string;
}

export interface IImportJob {
  _id: string;
  filename: string;
  fileSha256: string;
  status: ImportStatus;
  createdBy: string;
  headers: string[];
  /** Target field per header, same order as `headers` ("" = column ignored). Stored as an array: header text may contain '.' or '$'. */
  mapping: string[];
  totalRows: number;
  counts: Record<string, number>;
  /** Set when a commit starts; guards against double commits (stale claims expire). */
  committingAt?: Date | null;
  confirmedMasterRoster?: boolean;
  duplicateHandling?: "skip" | "import_soft";
  committedAt?: Date | null;
  committedBy?: string | null;
  result?: { created: number; skipped: number; failed: number };
  outcomes: IImportOutcome[];
  createdAt: Date;
  updatedAt: Date;
}

const job = makeSchema<IImportJob>({
  filename: { type: String, required: true },
  fileSha256: { type: String, required: true },
  status: { type: String, enum: IMPORT_STATUSES, default: "previewed", index: true },
  createdBy: { type: String, required: true, index: true },
  headers: { type: [String], default: [] },
  mapping: { type: [String], default: [] },
  totalRows: { type: Number, default: 0 },
  counts: { type: Object, default: {} },
  committingAt: { type: Date, default: null },
  confirmedMasterRoster: { type: Boolean, default: false },
  duplicateHandling: { type: String, enum: ["skip", "import_soft"] },
  committedAt: { type: Date, default: null },
  committedBy: { type: String, default: null },
  result: { created: Number, skipped: Number, failed: Number },
  outcomes: { type: [{ _id: false, row: Number, status: String, candidateId: String, candidateCode: String, message: String }], default: [] },
});
export const ImportJob = model<IImportJob>("ImportJob", job, "import_jobs");

/**
 * Parsed upload rows awaiting commit. Each row is ONE encrypted blob (encryptField of the JSON cell array) so that
 * names, emails and every sensitive identifier (SEVIS, EAD, DOB) are ciphertext at rest. Rows auto-expire after 24 h
 * (TTL) and are wiped as soon as the import is committed or cancelled.
 */
export interface IImportRow {
  _id: string;
  jobId: string;
  rowNumber: number;
  enc: string;
  expiresAt: Date;
}

const rowSchema = makeSchema<IImportRow>(
  {
    jobId: { type: String, required: true },
    rowNumber: { type: Number, required: true },
    enc: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false },
);
rowSchema.index({ jobId: 1, rowNumber: 1 }, { unique: true });
rowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ImportRow = model<IImportRow>("ImportRow", rowSchema, "import_rows");
