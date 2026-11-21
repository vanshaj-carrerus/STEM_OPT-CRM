import { createHash } from "node:crypto";
import { connectDb } from "@/lib/db/connect";
import { Candidate } from "@/lib/db/models/candidate";
import { ImportJob, ImportRow, type IImportJob, type IImportOutcome, type IImportRow } from "@/lib/db/models/import-job";
import { newId } from "@/lib/db/base";
import { audit } from "@/lib/audit";
import { assertCan, can, type Actor } from "@/lib/rbac/can";
import type { SessionUser } from "@/lib/auth/session";
import { decryptField, encryptField, maskValue } from "@/lib/crypto/field";
import { DuplicateCandidateError, createCandidate, nameDobHashOf, sevisHashOf } from "@/lib/candidates/service";
import { cleanFileName } from "@/lib/storage";
import { FIELD_BY_KEY, guessMapping, missingRequiredFields, sanitizeMapping } from "./fields";
import { parseRosterFile } from "./parse";
import {
  classifyRow,
  detectInFileDuplicates,
  ignoredFields,
  planCommit,
  validateRow,
  type ActorCaps,
  type DbDuplicate,
  type ValidatedRow,
} from "./rows";
import { ROW_STATUSES, type DuplicateHandling, type PreviewResponse, type PreviewRow, type RowStatus } from "./types";

export type { PreviewResponse, PreviewRow };

export class ImportError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 410 | 422,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

const PREVIEW_LIMIT = 500;
const ROW_TTL_MS = 24 * 3600_000;
const COMMIT_CLAIM_STALE_MS = 15 * 60_000;

export function capsFor(actor: Actor): ActorCaps {
  return {
    sevis: can(actor, "sensitive.sevis.view"),
    ead: can(actor, "sensitive.ead.view"),
    dob: can(actor, "sensitive.dob.view"),
    immigrationEdit: can(actor, "immigration.edit"),
  };
}

function assertImporter(actor: Actor) {
  assertCan(actor, "candidates.import");
  assertCan(actor, "candidates.create"); // every committed row goes through createCandidate()
}

/* ---------------------------- evaluation (preview & commit) ---------------------------- */

export interface EvaluatedRow extends ValidatedRow {
  status: RowStatus;
  message?: string;
}

const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/**
 * Batch version of candidates/service.findDuplicates for a whole file: hard = same email or SEVIS, soft = same
 * name + DOB (all via the same HMAC hashes, so no plaintext identifiers are ever queried or stored).
 */
export async function findDbDuplicates(rows: readonly ValidatedRow[]): Promise<Map<number, DbDuplicate>> {
  await connectDb();
  const out = new Map<number, DbDuplicate>();
  const probes = rows.filter((r) => r.input);
  const emails = [...new Set(probes.map((r) => r.probe.email).filter(Boolean) as string[])];
  const sevis = [...new Set(probes.map((r) => (r.probe.sevisId ? sevisHashOf(r.probe.sevisId) : null)).filter(Boolean) as string[])];
  const nameDob = [...new Set(probes.map((r) => (r.probe.legalName && r.probe.dateOfBirth ? nameDobHashOf(r.probe.legalName, r.probe.dateOfBirth) : null)).filter(Boolean) as string[])];

  const byEmail = new Map<string, string>();
  const bySevis = new Map<string, string>();
  const byNameDob = new Map<string, string>();
  type Hit = { candidateCode: string; emailLower: string; sevisHash?: string; nameDobHash?: string };
  const q = async (filter: Record<string, unknown>) =>
    Candidate.find(filter).select("candidateCode emailLower sevisHash nameDobHash").lean<Hit[]>();
  for (const part of chunk(emails, 1000)) for (const h of await q({ emailLower: { $in: part } })) byEmail.set(h.emailLower, h.candidateCode);
  for (const part of chunk(sevis, 1000)) for (const h of await q({ sevisHash: { $in: part } })) if (h.sevisHash) bySevis.set(h.sevisHash, h.candidateCode);
  for (const part of chunk(nameDob, 1000)) for (const h of await q({ nameDobHash: { $in: part } })) if (h.nameDobHash) byNameDob.set(h.nameDobHash, h.candidateCode);

  for (const r of probes) {
    const e = r.probe.email ? byEmail.get(r.probe.email) : undefined;
    const s = r.probe.sevisId ? bySevis.get(sevisHashOf(r.probe.sevisId)) : undefined;
    const n = r.probe.legalName && r.probe.dateOfBirth ? byNameDob.get(nameDobHashOf(r.probe.legalName, r.probe.dateOfBirth)) : undefined;
    if (e) out.set(r.rowNumber, { kind: "hard", code: e, reason: "Same email" });
    else if (s) out.set(r.rowNumber, { kind: "hard", code: s, reason: "Same SEVIS ID" });
    else if (n) out.set(r.rowNumber, { kind: "soft", code: n, reason: "Same name and date of birth" });
  }
  return out;
}

export async function evaluateRows(rows: { rowNumber: number; cells: string[] }[], mapping: (string | null)[], caps: ActorCaps): Promise<EvaluatedRow[]> {
  const validated = rows.map((r) => validateRow(r.rowNumber, r.cells, mapping, caps));
  const fileDups = detectInFileDuplicates(validated);
  const dbDups = await findDbDuplicates(validated);
  return validated.map((v) => ({ ...v, ...classifyRow(v, fileDups.get(v.rowNumber), dbDups.get(v.rowNumber)) }));
}

/* --------------------------------- preview shape --------------------------------- */

const ALL_STATUSES = ROW_STATUSES;
const SENSITIVE_HEADER = /ssn|social|passport|tax|itin|sevis|ead|birth|dob/i;

function maskedCells(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const f = FIELD_BY_KEY[k];
    out[k] = !f?.sensitive ? v : k === "dateOfBirth" ? "(provided)" : maskValue(v);
  }
  return out;
}

function toPreviewRow(r: EvaluatedRow): PreviewRow {
  const errors: Record<string, string> = {};
  for (const [k, msg] of Object.entries(r.errors)) errors[k] = FIELD_BY_KEY[k]?.sensitive ? "Invalid value" : msg;
  return { rowNumber: r.rowNumber, status: r.status, message: r.message, errors, cells: maskedCells(r.values) };
}

function buildPreview(job: IImportJob, rows: EvaluatedRow[], firstCells: string[], neutralizedCells: number, caps: ActorCaps): PreviewResponse {
  const mapping = job.mapping.map((m) => (m ? m : null));
  const summary = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<RowStatus, number>;
  for (const r of rows) summary[r.status]++;
  let shown = rows;
  let truncated = false;
  if (rows.length > PREVIEW_LIMIT) {
    // Problems first (they need attention), then a sample of valid rows, kept in file order.
    const problems = rows.filter((r) => r.status !== "valid").slice(0, PREVIEW_LIMIT);
    const valid = rows.filter((r) => r.status === "valid").slice(0, Math.max(50, PREVIEW_LIMIT - problems.length));
    shown = [...problems, ...valid].sort((a, b) => a.rowNumber - b.rowNumber);
    truncated = true;
  }
  const sample = job.headers.map((h, i) => {
    const f = mapping[i] ? FIELD_BY_KEY[mapping[i]!] : null;
    const v = firstCells[i] ?? "";
    return f?.sensitive || SENSITIVE_HEADER.test(h) ? (v ? maskValue(v) : "") : v.slice(0, 60);
  });
  return {
    jobId: job._id,
    filename: job.filename,
    totalRows: job.totalRows,
    headers: job.headers,
    mapping,
    sample,
    summary,
    rows: shown.map(toPreviewRow),
    truncated,
    ignoredFields: ignoredFields(mapping, caps),
    missingRequired: missingRequiredFields(mapping),
    neutralizedCells,
  };
}

const countsOf = (rows: EvaluatedRow[]) => {
  const c: Record<string, number> = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  for (const r of rows) c[r.status]++;
  return c;
};

/* ------------------------------------ preview ------------------------------------ */

/** Parse an uploaded roster, auto-map columns, validate + deduplicate every row, and store the encrypted rows. */
export async function createImportPreview(actor: SessionUser, fileName: string, data: Buffer): Promise<PreviewResponse> {
  assertImporter(actor);
  const sheet = await parseRosterFile(fileName, data); // throws ImportParseError (422 at the route)
  await connectDb();
  const caps = capsFor(actor);
  const mapping = guessMapping(sheet.headers);
  const rows = sheet.rows.map((cells, i) => ({ rowNumber: i + 2, cells })); // +2: spreadsheet row numbers (header is row 1)

  const jobId = newId();
  const evaluated = await evaluateRows(rows, mapping, caps);
  const job = await ImportJob.create({
    _id: jobId,
    filename: cleanFileName(fileName),
    fileSha256: createHash("sha256").update(data).digest("hex"),
    status: "previewed",
    createdBy: actor.id,
    headers: sheet.headers,
    mapping: mapping.map((m) => m ?? ""),
    totalRows: rows.length,
    counts: { ...countsOf(evaluated), neutralizedCells: sheet.neutralizedCells },
  });

  const expiresAt = new Date(Date.now() + ROW_TTL_MS);
  for (const part of chunk(rows, 500)) {
    await ImportRow.insertMany(
      part.map((r) => ({ _id: newId(), jobId, rowNumber: r.rowNumber, enc: encryptField(JSON.stringify(r.cells)), expiresAt })),
      { ordered: true },
    );
  }

  await audit({
    actor,
    action: "import",
    entityType: "import_job",
    entityId: jobId,
    summary: `Previewed roster import "${job.filename}" (${rows.length} rows)`,
    after: { filename: job.filename, rows: rows.length, ...countsOf(evaluated) },
  });
  return buildPreview(job.toObject() as IImportJob, evaluated, sheet.rows[0] ?? [], sheet.neutralizedCells, caps);
}

async function loadOwnJob(actor: SessionUser, jobId: string): Promise<IImportJob> {
  await connectDb();
  const job = await ImportJob.findById(jobId).lean<IImportJob>();
  if (!job || job.createdBy !== actor.id) throw new ImportError(404, "Import not found.");
  return job;
}

async function loadRows(jobId: string): Promise<{ rowNumber: number; cells: string[] }[]> {
  const stored = await ImportRow.find({ jobId }).sort({ rowNumber: 1 }).lean<IImportRow[]>();
  return stored.map((r) => ({ rowNumber: r.rowNumber, cells: JSON.parse(decryptField(r.enc)) as string[] }));
}

/** Re-run validation + dedupe with a user-adjusted column mapping (header-aligned field keys, null = ignore). */
export async function remapImport(actor: SessionUser, jobId: string, requested: (string | null)[]): Promise<PreviewResponse> {
  assertImporter(actor);
  const job = await loadOwnJob(actor, jobId);
  if (job.status !== "previewed") throw new ImportError(409, "This import has already been committed or cancelled.");
  const rows = await loadRows(jobId);
  if (rows.length === 0) throw new ImportError(410, "This preview has expired. Upload the file again.");

  const mapping = sanitizeMapping(requested, job.headers.length);
  const caps = capsFor(actor);
  const evaluated = await evaluateRows(rows, mapping, caps);
  const neutralized = job.counts?.neutralizedCells ?? 0;
  const updated = await ImportJob.findOneAndUpdate(
    { _id: jobId, status: "previewed" },
    { $set: { mapping: mapping.map((m) => m ?? ""), counts: { ...countsOf(evaluated), neutralizedCells: neutralized } } },
    { returnDocument: "after" },
  ).lean<IImportJob>();
  if (!updated) throw new ImportError(409, "This import has already been committed or cancelled.");
  return buildPreview(updated, evaluated, rows[0]?.cells ?? [], neutralized, caps);
}

export async function cancelImport(actor: SessionUser, jobId: string): Promise<void> {
  assertCan(actor, "candidates.import");
  const job = await loadOwnJob(actor, jobId);
  if (job.status !== "previewed") throw new ImportError(409, "This import has already been committed or cancelled.");
  await ImportJob.updateOne({ _id: jobId, status: "previewed" }, { $set: { status: "cancelled" } });
  await ImportRow.deleteMany({ jobId });
  await audit({ actor, action: "import", entityType: "import_job", entityId: jobId, summary: `Cancelled roster import "${job.filename}"`, after: { filename: job.filename, status: "cancelled" } });
}

/* ------------------------------------- commit ------------------------------------- */

export interface CommitResult {
  jobId: string;
  created: number;
  skipped: number;
  failed: number;
  outcomes: IImportOutcome[];
}

/**
 * Create the candidates. Every row goes through createCandidate() (permissions, encryption, dedupe, audit). A
 * duplicate or error on one row is recorded and never aborts the batch. The caller must have ticked the explicit
 * "approved master roster" confirmation; sensitive row data is wiped afterwards.
 */
export async function commitImport(
  actor: SessionUser,
  jobId: string,
  opts: { confirmMasterRoster: boolean; duplicateHandling: DuplicateHandling },
): Promise<CommitResult> {
  assertImporter(actor);
  if (opts.confirmMasterRoster !== true) {
    throw new ImportError(422, "Confirm that this file is the approved, validated master roster before importing.");
  }
  const job = await loadOwnJob(actor, jobId);
  if (job.status !== "previewed") throw new ImportError(409, "This import has already been committed or cancelled.");

  // Atomically claim the job so a double-click / second tab cannot import twice (stale claims expire).
  const claimed = await ImportJob.findOneAndUpdate(
    {
      _id: jobId,
      status: "previewed",
      $or: [{ committingAt: null }, { committingAt: { $lt: new Date(Date.now() - COMMIT_CLAIM_STALE_MS) } }],
    },
    { $set: { committingAt: new Date() } },
  ).lean<IImportJob>();
  if (!claimed) throw new ImportError(409, "This import is already being committed.");

  const stored = await loadRows(jobId);
  if (stored.length === 0) {
    await ImportJob.updateOne({ _id: jobId }, { $set: { committingAt: null } });
    throw new ImportError(410, "This preview has expired. Upload the file again.");
  }

  const mapping = job.mapping.map((m) => (m ? m : null));
  if (missingRequiredFields(mapping).length) {
    await ImportJob.updateOne({ _id: jobId }, { $set: { committingAt: null } });
    throw new ImportError(422, `Map the required columns first: ${missingRequiredFields(mapping).join(", ")}.`);
  }
  const caps = capsFor(actor);
  const evaluated = await evaluateRows(stored, mapping, caps); // re-evaluated: the database may have changed since the preview
  const plan = planCommit(evaluated, opts.duplicateHandling);
  const toImport = new Set(plan.importRows);

  const outcomes: IImportOutcome[] = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of evaluated) {
    if (!toImport.has(row.rowNumber)) {
      skipped++;
      // Never store cell values in outcomes: invalid rows list field names only.
      const message = row.status === "invalid" ? `Invalid: ${Object.keys(row.errors).join(", ")}` : row.message;
      outcomes.push({ row: row.rowNumber, status: `skipped_${row.status}`, message });
      continue;
    }
    try {
      const c = await createCandidate(actor, row.input!, { allowSoftDuplicate: opts.duplicateHandling === "import_soft" });
      created++;
      outcomes.push({ row: row.rowNumber, status: "created", candidateId: c._id, candidateCode: c.candidateCode });
    } catch (e) {
      if (e instanceof DuplicateCandidateError) {
        skipped++;
        outcomes.push({
          row: row.rowNumber,
          status: e.kind === "hard" ? "skipped_duplicate_db" : "skipped_possible_duplicate_db",
          message: `${e.matches[0]?.reason ?? "Duplicate"} as existing candidate ${e.matches[0]?.code ?? ""}`.trim(),
        });
      } else {
        failed++;
        console.error(`[import ${jobId}] row ${row.rowNumber} failed`, e);
        outcomes.push({ row: row.rowNumber, status: "failed", message: "The record could not be created." });
      }
    }
  }

  await ImportJob.updateOne(
    { _id: jobId },
    {
      $set: {
        status: "committed",
        committedAt: new Date(),
        committedBy: actor.id,
        committingAt: null,
        confirmedMasterRoster: true,
        duplicateHandling: opts.duplicateHandling,
        result: { created, skipped, failed },
        outcomes,
      },
    },
  );
  await ImportRow.deleteMany({ jobId }); // wipe sensitive row data immediately
  await audit({
    actor,
    action: "import",
    entityType: "import_job",
    entityId: jobId,
    summary: `Imported roster "${job.filename}": ${created} created, ${skipped} skipped, ${failed} failed`,
    after: { filename: job.filename, totalRows: job.totalRows, created, skipped, failed, duplicateHandling: opts.duplicateHandling, confirmedMasterRoster: true },
  });
  return { jobId, created, skipped, failed, outcomes };
}
