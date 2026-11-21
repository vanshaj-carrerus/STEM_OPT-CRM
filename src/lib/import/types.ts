/** DB-free import types and constants — safe to import from client components. */

export type RowStatus =
  | "valid"
  | "invalid"
  | "duplicate_db" // same email / SEVIS as an existing candidate (hard — never imported)
  | "possible_duplicate_db" // same name + DOB as an existing candidate (soft)
  | "duplicate_file" // same email / SEVIS as an earlier row in this file (hard)
  | "possible_duplicate_file"; // same name + DOB as an earlier row in this file (soft)

export const ROW_STATUSES: RowStatus[] = ["valid", "invalid", "duplicate_db", "possible_duplicate_db", "duplicate_file", "possible_duplicate_file"];

export const ROW_STATUS_LABELS: Record<RowStatus, string> = {
  valid: "Valid",
  invalid: "Invalid",
  duplicate_db: "Duplicate (already in CRM)",
  possible_duplicate_db: "Possible duplicate (name + DOB in CRM)",
  duplicate_file: "Duplicate (earlier row in file)",
  possible_duplicate_file: "Possible duplicate (name + DOB in file)",
};

export type DuplicateHandling = "skip" | "import_soft";

export interface PreviewRow {
  rowNumber: number;
  status: RowStatus;
  message?: string;
  errors: Record<string, string>;
  /** Normalised values for mapped fields; protected identifiers are masked. */
  cells: Record<string, string>;
}

export interface PreviewResponse {
  jobId: string;
  filename: string;
  totalRows: number;
  headers: string[];
  /** Target field key per header (null = unmapped / ignored). */
  mapping: (string | null)[];
  /** First data row, per header, for orientation (identifier-like columns masked). */
  sample: string[];
  summary: Record<RowStatus, number>;
  rows: PreviewRow[];
  truncated: boolean;
  ignoredFields: string[];
  missingRequired: string[];
  neutralizedCells: number;
}

export interface CommitSummary {
  jobId: string;
  created: number;
  skipped: number;
  failed: number;
  outcomes: { row: number; status: string; candidateCode?: string; message?: string }[];
}
