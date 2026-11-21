/**
 * Pure row logic for the roster import: mapping → normalisation → validation (via the same candidateCreateSchema
 * the manual form uses) → in-file duplicate detection → commit planning. No DB or I/O in this file.
 */
import { candidateCreateSchema, type CandidateInput } from "@/lib/candidates/schema";
import { AUTH_TYPES, CANDIDATE_STAGES } from "@/lib/db/models/candidate";
import { normalizeDate } from "./dates";
import { FIELD_BY_KEY } from "./fields";
import type { DuplicateHandling, RowStatus } from "./types";

/** What the importing user may actually store — createCandidate silently drops the rest, so the preview warns. */
export interface ActorCaps {
  sevis: boolean;
  ead: boolean;
  dob: boolean;
  immigrationEdit: boolean;
}

export interface DedupeProbe {
  email?: string;
  sevisId?: string;
  legalName?: string;
  dateOfBirth?: string;
}

export interface ValidatedRow {
  rowNumber: number;
  /** Normalised values by field key (dates already YYYY-MM-DD). Held in memory only; never persisted in clear. */
  values: Record<string, string>;
  /** Parsed candidate input when the row has no errors. */
  input?: CandidateInput;
  errors: Record<string, string>;
  /** Identifiers used for duplicate detection, gated exactly like createCandidate gates them. */
  probe: DedupeProbe;
}

const norm = (s?: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/* ------------------------------ enum parsing ------------------------------ */

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseAuthType(v: string): string | null {
  const s = squash(v);
  if (["", "none", "na", "notset", "unknown"].includes(s)) return "none";
  if (s === "cpt") return "CPT";
  if (s === "opt" || s === "postcompletionopt" || s === "preopt") return "OPT";
  if (["stemopt", "stem", "stemextension", "opt24", "stemoptextension", "optstem"].includes(s)) return "STEM_OPT";
  return (AUTH_TYPES as readonly string[]).includes(v) ? v : null;
}

export function parseStage(v: string): string | null {
  const s = squash(v);
  const hit = CANDIDATE_STAGES.find((st) => squash(st) === s);
  return hit ?? null;
}

export function parsePriority(v: string): string | null {
  const s = squash(v);
  if (s === "medium") return "normal";
  return ["low", "normal", "high", "urgent"].includes(s) ? s : null;
}

const ENUM_PARSERS: Record<string, (v: string) => string | null> = {
  authType: parseAuthType,
  stage: parseStage,
  priority: parsePriority,
};

/* -------------------------------- validation -------------------------------- */

/** Raw cells → field values using a header-aligned mapping (null = ignored column). */
export function mapCells(cells: readonly string[], mapping: readonly (string | null)[]): Record<string, string> {
  const out: Record<string, string> = {};
  mapping.forEach((field, i) => {
    const v = (cells[i] ?? "").trim();
    if (field && v !== "") out[field] = v;
  });
  return out;
}

export function validateRow(rowNumber: number, cells: readonly string[], mapping: readonly (string | null)[], caps: ActorCaps): ValidatedRow {
  const values = mapCells(cells, mapping);
  const errors: Record<string, string> = {};

  if (!values.legalName && (values.firstName || values.lastName)) {
    values.legalName = [values.firstName, values.lastName].filter(Boolean).join(" ");
  }
  delete values.firstName;
  delete values.lastName;

  for (const [key, v] of Object.entries(values)) {
    const def = FIELD_BY_KEY[key];
    if (!def) continue;
    if (def.kind === "date") {
      const d = normalizeDate(v);
      if (d.error) {
        errors[key] = d.error;
        delete values[key];
      } else if (d.value) values[key] = d.value;
    } else if (def.kind === "enum") {
      const parsed = ENUM_PARSERS[key]?.(v);
      if (parsed == null) {
        errors[key] = `Unrecognised ${def.label.toLowerCase()} "${v.slice(0, 30)}"`;
        delete values[key];
      } else values[key] = parsed;
    }
  }

  const parsed = candidateCreateSchema.safeParse(values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors[String(issue.path[0] ?? "row")] ??= issue.message;
  }
  const input = parsed.success && Object.keys(errors).length === 0 ? parsed.data : undefined;

  const probe: DedupeProbe = {};
  if (input) {
    probe.email = input.email;
    probe.legalName = input.legalName;
    if (caps.sevis && input.sevisId) probe.sevisId = input.sevisId.trim().toUpperCase();
    if (caps.dob && input.dateOfBirth) probe.dateOfBirth = input.dateOfBirth;
  }
  return { rowNumber, values, input, errors, probe };
}

/** Field keys the user mapped but is not allowed to store (reported in the preview instead of silently dropped). */
export function ignoredFields(mapping: readonly (string | null)[], caps: ActorCaps): string[] {
  const out: string[] = [];
  for (const key of mapping) {
    const f = key ? FIELD_BY_KEY[key] : null;
    if (!f) continue;
    const blockedByImmigration = f.immigration && !caps.immigrationEdit;
    const blockedBySensitive =
      (key === "sevisId" && !caps.sevis) || (key === "eadNumber" && !caps.ead) || (key === "dateOfBirth" && !caps.dob);
    if (blockedByImmigration || blockedBySensitive) out.push(f.label);
  }
  return out;
}

/* ------------------------------ duplicate planning ------------------------------ */

export type { RowStatus, DuplicateHandling };

export interface FileDuplicate {
  kind: "hard" | "soft";
  /** Row number of the first occurrence that this row duplicates. */
  ofRow: number;
  reason: string;
}

/**
 * Flags rows that repeat an identifier already seen EARLIER in the file (the first occurrence stays importable).
 * Only error-free rows participate, so an invalid row never "claims" an email.
 */
export function detectInFileDuplicates(rows: readonly ValidatedRow[]): Map<number, FileDuplicate> {
  const byEmail = new Map<string, number>();
  const bySevis = new Map<string, number>();
  const byNameDob = new Map<string, number>();
  const out = new Map<number, FileDuplicate>();
  for (const r of rows) {
    if (Object.keys(r.errors).length || !r.input) continue;
    const email = r.probe.email ? norm(r.probe.email) : undefined;
    const sevis = r.probe.sevisId ? r.probe.sevisId.trim().toUpperCase() : undefined;
    const nameDob = r.probe.legalName && r.probe.dateOfBirth ? `${norm(r.probe.legalName)}|${r.probe.dateOfBirth}` : undefined;

    const emailFirst = email ? byEmail.get(email) : undefined;
    const sevisFirst = sevis ? bySevis.get(sevis) : undefined;
    const nameDobFirst = nameDob ? byNameDob.get(nameDob) : undefined;
    if (emailFirst !== undefined) out.set(r.rowNumber, { kind: "hard", ofRow: emailFirst, reason: `Same email as row ${emailFirst}` });
    else if (sevisFirst !== undefined) out.set(r.rowNumber, { kind: "hard", ofRow: sevisFirst, reason: `Same SEVIS ID as row ${sevisFirst}` });
    else if (nameDobFirst !== undefined) out.set(r.rowNumber, { kind: "soft", ofRow: nameDobFirst, reason: `Same name and date of birth as row ${nameDobFirst}` });
    else {
      if (email) byEmail.set(email, r.rowNumber);
      if (sevis) bySevis.set(sevis, r.rowNumber);
      if (nameDob) byNameDob.set(nameDob, r.rowNumber);
    }
  }
  return out;
}

export interface DbDuplicate {
  kind: "hard" | "soft";
  /** Candidate code of the existing record (no other details are exposed). */
  code: string;
  reason: string;
}

export function classifyRow(row: ValidatedRow, fileDup?: FileDuplicate, dbDup?: DbDuplicate): { status: RowStatus; message?: string } {
  if (Object.keys(row.errors).length) return { status: "invalid" };
  if (dbDup?.kind === "hard") return { status: "duplicate_db", message: `${dbDup.reason} as existing candidate ${dbDup.code}` };
  if (fileDup?.kind === "hard") return { status: "duplicate_file", message: fileDup.reason };
  if (dbDup?.kind === "soft") return { status: "possible_duplicate_db", message: `${dbDup.reason} as existing candidate ${dbDup.code}` };
  if (fileDup?.kind === "soft") return { status: "possible_duplicate_file", message: fileDup.reason };
  return { status: "valid" };
}

/**
 * Which rows will be committed. Hard duplicates and invalid rows are never imported; soft (name + DOB) duplicates
 * are skipped unless the user explicitly chose "import_soft".
 */
export function planCommit(rows: readonly { rowNumber: number; status: RowStatus }[], handling: DuplicateHandling) {
  const importRows: number[] = [];
  const skipped: { rowNumber: number; status: RowStatus }[] = [];
  for (const r of rows) {
    const soft = r.status === "possible_duplicate_db" || r.status === "possible_duplicate_file";
    if (r.status === "valid" || (soft && handling === "import_soft")) importRows.push(r.rowNumber);
    else skipped.push(r);
  }
  return { importRows, skipped };
}
