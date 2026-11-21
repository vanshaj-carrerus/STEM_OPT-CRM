import { connectDb } from "@/lib/db/connect";
import { DocumentModel, type IDocument } from "@/lib/db/models/document";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { Employer } from "@/lib/db/models/employer";
import { newId } from "@/lib/db/base";
import { audit } from "@/lib/audit";
import { regenerateComplianceSchedule } from "@/lib/tasks/triggers";
import { loadCandidateFor } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { assertCan, can, candidateScopeFilter, type Actor } from "@/lib/rbac/can";
import { addDays, compareDates, todayIn, type DateOnly } from "@/lib/compliance/dates";
import {
  cleanFileName,
  newObjectKey,
  scanUpload,
  sha256Hex,
  signDownloadToken,
  storage,
} from "@/lib/storage";
import { DOCUMENT_TYPES, DOCUMENT_TYPE_MAP, type DocumentCategory, type VerificationState } from "./types";
import {
  assertReviewerAllowed,
  canPreviewInline,
  computeMissing,
  contentTypeFor,
  daysUntilExpiry,
  displayStatus,
  isRestrictedType,
  nextVersion,
  validateReview,
  type DisplayStatus,
  type MissingDocument,
  type MissingReason,
} from "./rules";
import type { QueueFilter, ReviewInput, UploadMeta } from "./schema";

/** User-facing failure with an HTTP-ish status. Routes map it to a JSON error, actions to form state. */
export class DocumentError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 413 | 422,
    message: string,
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

const NOT_FOUND = () => new DocumentError(404, "Document not found.");
const DEFAULT_TZ = "America/New_York";
const RESTRICTED_TYPES = DOCUMENT_TYPES.filter((t) => isRestrictedType(t.key)).map((t) => t.key);
/** Candidates in these stages are excluded from compliance counts / queues (nothing left to chase). */
const INACTIVE_STAGES: ICandidate["stage"][] = ["offboarded", "archived"];

const canSeeRestricted = (actor: Actor) => can(actor, "sensitive.tax.view");

/* --------------------------------- views --------------------------------- */

/** Serializable document row. Never carries the storage object key. */
export interface DocumentView {
  id: string;
  candidateId: string;
  groupId: string;
  version: number;
  isLatest: boolean;
  category: DocumentCategory;
  type: string;
  typeLabel: string;
  title?: string;
  employerId?: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  issueDate?: string;
  expiryDate?: string;
  verification: VerificationState;
  reviewerId?: string | null;
  reviewedAt: string | null;
  reviewNote?: string;
  restricted: boolean;
  previewable: boolean;
  uploadedBy: string;
  uploadedAt: string;
}

export function toDocumentView(d: IDocument): DocumentView {
  return {
    id: d._id,
    candidateId: d.candidateId,
    groupId: d.groupId,
    version: d.version,
    isLatest: d.isLatest,
    category: d.category,
    type: d.type,
    typeLabel: DOCUMENT_TYPE_MAP[d.type]?.label ?? d.type,
    title: d.title,
    employerId: d.employerId ?? null,
    fileName: d.fileName,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    sha256: d.sha256,
    issueDate: d.issueDate,
    expiryDate: d.expiryDate,
    verification: d.verification,
    reviewerId: d.reviewerId ?? null,
    reviewedAt: d.reviewedAt ? new Date(d.reviewedAt).toISOString() : null,
    reviewNote: d.reviewNote,
    restricted: d.restricted,
    previewable: canPreviewInline(d.contentType),
    uploadedBy: d.uploadedBy,
    uploadedAt: new Date(d.createdAt).toISOString(),
  };
}

export interface DocumentGroupView {
  groupId: string;
  type: string;
  typeLabel: string;
  category: DocumentCategory;
  latest: DocumentView;
  /** Older versions, newest first. */
  history: DocumentView[];
}

/* -------------------------------- listing -------------------------------- */

/**
 * Latest version + version history for each logical document of a candidate. Requires documents.view and
 * record-level access to the candidate; restricted (payroll/tax) documents are omitted entirely unless the actor
 * also holds sensitive.tax.view.
 */
export async function listCandidateDocuments(actor: SessionUser, candidateId: string): Promise<DocumentGroupView[]> {
  assertCan(actor, "documents.view");
  const candidate = await loadCandidateFor(actor, candidateId);
  if (!candidate) throw new DocumentError(404, "Candidate not found.");
  const rows = await DocumentModel.find({
    candidateId,
    ...(canSeeRestricted(actor) ? {} : { restricted: { $ne: true }, type: { $nin: RESTRICTED_TYPES } }),
  })
    .sort({ version: -1 })
    .lean<IDocument[]>();

  const groups = new Map<string, IDocument[]>();
  for (const r of rows) {
    const g = groups.get(r.groupId);
    if (g) g.push(r);
    else groups.set(r.groupId, [r]);
  }
  const out: DocumentGroupView[] = [];
  for (const versions of groups.values()) {
    const [latest, ...older] = versions; // already newest first
    out.push({
      groupId: latest.groupId,
      type: latest.type,
      typeLabel: DOCUMENT_TYPE_MAP[latest.type]?.label ?? latest.type,
      category: latest.category,
      latest: toDocumentView(latest),
      history: older.map(toDocumentView),
    });
  }
  const order = (t: string) => DOCUMENT_TYPES.findIndex((x) => x.key === t);
  return out.sort((a, b) => order(a.type) - order(b.type) || a.latest.uploadedAt.localeCompare(b.latest.uploadedAt));
}

/**
 * Authorization-evidence lookup for the immigration module: returns the document only when it belongs to the
 * candidate AND is verified. (No actor: callers enforce their own permissions; this returns the raw row for server use.)
 */
export async function getVerifiedDocument(candidateId: string, documentId: string): Promise<IDocument | null> {
  await connectDb();
  return DocumentModel.findOne({ _id: documentId, candidateId, verification: "verified" }).lean<IDocument>();
}

/** Required document types not currently satisfied for a candidate (see rules.computeMissing). */
export async function getMissingDocuments(candidateId: string, opts: { today?: DateOnly } = {}): Promise<MissingDocument[]> {
  await connectDb();
  const c = await Candidate.findById(candidateId).select("authType").lean<ICandidate>();
  if (!c) return [];
  const docs = await DocumentModel.find({ candidateId, isLatest: true }).select("type isLatest verification expiryDate").lean<IDocument[]>();
  return computeMissing(c.authType, docs, opts.today ?? todayIn(DEFAULT_TZ));
}

/* ------------------------- upload (new doc / new version) ------------------------- */

export interface UploadInput {
  fileName: string;
  data: Buffer;
  meta: UploadMeta;
}

export async function uploadDocument(actor: SessionUser, candidateId: string, input: UploadInput): Promise<DocumentView> {
  assertCan(actor, "documents.upload");
  const candidate = await loadCandidateFor(actor, candidateId);
  if (!candidate) throw new DocumentError(404, "Candidate not found.");
  const { meta } = input;

  // A groupId means "new version of this logical document": type/category are inherited, never re-chosen.
  let base: IDocument | null = null;
  if (meta.groupId) {
    base = await DocumentModel.findOne({ groupId: meta.groupId, candidateId, isLatest: true }).lean<IDocument>();
    if (!base) throw NOT_FOUND();
  }
  const type = base?.type ?? meta.type!;
  const def = DOCUMENT_TYPE_MAP[type];
  if (!def) throw new DocumentError(422, "Unknown document type.");
  const restricted = isRestrictedType(type);
  if (restricted && !canSeeRestricted(actor)) {
    throw new DocumentError(403, "You do not have access to payroll / tax documents.");
  }

  const employerId = meta.employerId ?? base?.employerId ?? null;
  if (employerId && !(await Employer.exists({ _id: employerId }))) throw new DocumentError(422, "Unknown employer.");

  const fileName = cleanFileName(input.fileName);
  const scan = await scanUpload(input.data, fileName);
  if (!scan.ok) throw new DocumentError(422, scan.reason ?? "The file failed security screening.");

  const objectKey = newObjectKey(candidateId);
  await storage().put(objectKey, input.data); // encrypted at rest; orphan objects after a DB failure are harmless

  const groupId = base?.groupId ?? newId();
  let created: IDocument | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const versions = (await DocumentModel.find({ groupId }).select("version").lean<{ version: number }[]>()).map((v) => v.version);
    try {
      const doc = await DocumentModel.create({
        candidateId,
        groupId,
        version: nextVersion(versions),
        isLatest: true,
        category: def.category,
        type,
        title: meta.title ?? base?.title,
        employerId,
        objectKey,
        fileName,
        contentType: contentTypeFor(fileName),
        sizeBytes: input.data.length,
        sha256: sha256Hex(input.data),
        issueDate: meta.issueDate,
        expiryDate: meta.expiryDate,
        verification: "pending_review", // a new version ALWAYS restarts review
        reviewerId: null,
        reviewedAt: null,
        restricted,
        scan: { ok: true, engine: scan.engine },
        uploadedBy: actor.id,
      });
      created = doc.toObject() as IDocument;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000 || attempt === 2) throw e; // lost a version race: recompute
    }
  }
  if (!created) throw new DocumentError(409, "Could not record the upload; please retry.");

  // Flip the superseded versions only after the new one exists, so a candidate never has zero latest versions.
  await DocumentModel.updateMany({ groupId, version: { $lt: created.version }, isLatest: true }, { $set: { isLatest: false } });

  await audit({
    actor,
    action: "create",
    entityType: "document",
    entityId: created._id,
    candidateId,
    summary: `Uploaded ${def.label} v${created.version} (${fileName})`,
    after: { type, version: created.version, groupId, fileName, sizeBytes: created.sizeBytes, sha256: created.sha256, scanEngine: scan.engine, restricted },
  });
  // A new version restarts review, so a previously verified evidence document stops counting until re-verified.
  if (base) await recheckCompliance(actor, candidateId, def.category);
  return toDocumentView(created);
}

/* -------------------------------- verification -------------------------------- */

/** Verify or reject the latest version of a document. Audited; the uploader cannot review their own upload. */
export async function reviewDocument(actor: SessionUser, input: ReviewInput): Promise<DocumentView> {
  assertCan(actor, "documents.verify");
  const doc = await loadAccessibleDocument(actor, input.documentId);
  const today = todayIn(actor.timezone);

  const problem = validateReview({
    from: doc.verification,
    decision: input.decision,
    note: input.note,
    isLatest: doc.isLatest,
    expiryDate: doc.expiryDate,
    today,
  });
  if (problem) throw new DocumentError(409, problem);
  assertReviewerAllowed(actor.id, actor.role, doc.uploadedBy);

  const note = input.note?.trim() || undefined;
  const res = await DocumentModel.updateOne(
    { _id: doc._id, verification: "pending_review", isLatest: true }, // guards against concurrent reviews
    { $set: { verification: input.decision, reviewerId: actor.id, reviewedAt: new Date(), reviewNote: note } },
  );
  if (res.modifiedCount !== 1) throw new DocumentError(409, "This document was already reviewed or replaced. Refresh and try again.");

  await audit({
    actor,
    action: input.decision === "verified" ? "approve" : "reject",
    entityType: "document",
    entityId: doc._id,
    candidateId: doc.candidateId,
    summary: `${input.decision === "verified" ? "Verified" : "Rejected"} ${DOCUMENT_TYPE_MAP[doc.type]?.label ?? doc.type} v${doc.version}`,
    reason: note,
    before: { verification: doc.verification },
    after: { verification: input.decision, reviewerId: actor.id },
  });
  await recheckCompliance(actor, doc.candidateId, doc.category);
  const fresh = await DocumentModel.findById(doc._id).lean<IDocument>();
  return toDocumentView(fresh!);
}

/**
 * A document's verification state can change what counts as authorization evidence, so re-derive milestones and
 * re-check clearance (revoking it if the evidence is no longer verified). The document action has already succeeded
 * and is audited, so a scheduling failure is logged — never allowed to undo or hide it.
 */
async function recheckCompliance(actor: SessionUser, candidateId: string, category: DocumentCategory) {
  if (category !== "immigration" && category !== "employment") return;
  try {
    await regenerateComplianceSchedule({ actor, candidateId });
  } catch (err) {
    console.error(`[documents] compliance re-check failed for candidate ${candidateId}:`, (err as Error).message);
  }
}

/* ---------------------------------- download ---------------------------------- */

/**
 * Permission + record-level + restricted check shared by every route that touches a document.
 * "No access" and "does not exist" are indistinguishable (404).
 */
async function loadAccessibleDocument(actor: SessionUser, documentId: string): Promise<IDocument> {
  await connectDb();
  const doc = await DocumentModel.findById(documentId).lean<IDocument>();
  if (!doc) throw NOT_FOUND();
  if (!(await loadCandidateFor(actor, doc.candidateId))) throw NOT_FOUND();
  if ((doc.restricted || isRestrictedType(doc.type)) && !canSeeRestricted(actor)) throw NOT_FOUND();
  return doc;
}

/** Resolve a document for download/preview: documents.download + candidate access + restricted flag. */
export async function getDownloadableDocument(actor: SessionUser, documentId: string): Promise<IDocument> {
  assertCan(actor, "documents.download");
  return loadAccessibleDocument(actor, documentId);
}

/** Mint a 60-second, user-bound signed URL for the download route. */
export async function mintDownloadUrl(actor: SessionUser, documentId: string, inline = false): Promise<string> {
  const doc = await getDownloadableDocument(actor, documentId);
  if (inline && !canPreviewInline(doc.contentType)) throw new DocumentError(422, "This file type cannot be previewed; download it instead.");
  const token = signDownloadToken(doc._id, actor.id, 60);
  return `/api/documents/${doc._id}/download?token=${encodeURIComponent(token)}${inline ? "&inline=1" : ""}`;
}

/** Decrypt the stored bytes and check them against the recorded hash (tamper / corruption detection). */
export async function readDocumentBytes(doc: IDocument): Promise<Buffer> {
  const bytes = await storage().get(doc.objectKey);
  if (sha256Hex(bytes) !== doc.sha256) throw new Error(`Integrity check failed for document ${doc._id}`);
  return bytes;
}

/* ------------------------ cross-candidate queue / stats ------------------------ */

export interface QueueRow {
  key: string;
  kind: "document" | "missing";
  candidateId: string;
  candidateCode: string;
  candidateName: string;
  type: string;
  typeLabel: string;
  status: DisplayStatus | MissingReason;
  documentId?: string;
  fileName?: string;
  version?: number;
  expiryDate?: string;
  daysLeft?: number | null;
  uploadedAt?: string;
}

type Slim = Pick<IDocument, "_id" | "candidateId" | "type" | "verification" | "expiryDate" | "isLatest" | "fileName" | "version" | "createdAt">;

interface Analysis {
  today: DateOnly;
  docRows: QueueRow[]; // one per latest document
  missingRows: QueueRow[]; // one per unsatisfied required type (any reason)
}

/** Loads the actor's candidate scope + latest documents once and classifies everything. Empty without documents.view. */
async function analyse(actor: Actor & { timezone?: string }): Promise<Analysis> {
  const today = todayIn(actor.timezone ?? DEFAULT_TZ);
  const empty = { today, docRows: [], missingRows: [] };
  if (!can(actor, "documents.view") || !can(actor, "candidates.view")) return empty;
  await connectDb();
  const cands = await Candidate.find({ ...candidateScopeFilter(actor), stage: { $nin: INACTIVE_STAGES } })
    .select("candidateCode legalName authType")
    .lean<ICandidate[]>();
  if (!cands.length) return empty;
  const byId = new Map(cands.map((c) => [c._id, c]));
  const docs = await DocumentModel.find({
    candidateId: { $in: [...byId.keys()] },
    isLatest: true,
    ...(canSeeRestricted(actor) ? {} : { restricted: { $ne: true }, type: { $nin: RESTRICTED_TYPES } }),
  })
    .select("candidateId type verification expiryDate isLatest fileName version createdAt")
    .lean<Slim[]>();

  const docRows: QueueRow[] = docs.map((d) => {
    const c = byId.get(d.candidateId)!;
    return {
      key: d._id,
      kind: "document",
      candidateId: c._id,
      candidateCode: c.candidateCode,
      candidateName: c.legalName,
      type: d.type,
      typeLabel: DOCUMENT_TYPE_MAP[d.type]?.label ?? d.type,
      status: displayStatus(d, today),
      documentId: d._id,
      fileName: d.fileName,
      version: d.version,
      expiryDate: d.expiryDate,
      daysLeft: daysUntilExpiry(d.expiryDate, today),
      uploadedAt: new Date(d.createdAt).toISOString(),
    };
  });

  const docsByCandidate = new Map<string, Slim[]>();
  for (const d of docs) {
    const list = docsByCandidate.get(d.candidateId) ?? [];
    list.push(d);
    docsByCandidate.set(d.candidateId, list);
  }
  const missingRows: QueueRow[] = [];
  for (const c of cands) {
    let gaps = computeMissing(c.authType, docsByCandidate.get(c._id) ?? [], today);
    if (!canSeeRestricted(actor)) gaps = gaps.filter((g) => !isRestrictedType(g.type));
    for (const g of gaps) {
      missingRows.push({
        key: `${c._id}:${g.type}`,
        kind: "missing",
        candidateId: c._id,
        candidateCode: c.candidateCode,
        candidateName: c.legalName,
        type: g.type,
        typeLabel: g.label,
        status: g.reason,
      });
    }
  }
  return { today, docRows, missingRows };
}

const inWindow = (r: QueueRow, today: DateOnly, withinDays: number) =>
  r.status !== "rejected" && r.status !== "expired" && !!r.expiryDate && compareDates(r.expiryDate, addDays(today, withinDays)) <= 0;

export interface DocumentStats {
  /** Required document slots with nothing uploaded at all. */
  missing: number;
  /** Latest versions past their expiry date (not rejected). */
  expired: number;
  /** Latest versions that were rejected and need a re-upload. */
  rejected: number;
  /** Latest versions pending review. */
  awaitingReview: number;
  /** Latest versions (not expired/rejected) expiring within 30 days. */
  expiring30: number;
  /** Candidates with at least one required document not satisfied (any reason). */
  candidatesWithGaps: number;
}

/** Counts for dashboard/reports, scoped to candidates the actor may access (zeros without documents.view). */
export async function documentStats(actor: Actor & { timezone?: string }): Promise<DocumentStats> {
  const { today, docRows, missingRows } = await analyse(actor);
  return {
    missing: missingRows.filter((r) => r.status === "not_uploaded").length,
    expired: docRows.filter((r) => r.status === "expired").length,
    rejected: docRows.filter((r) => r.status === "rejected").length,
    awaitingReview: docRows.filter((r) => r.status === "pending_review").length,
    expiring30: docRows.filter((r) => inWindow(r, today, 30)).length,
    candidatesWithGaps: new Set(missingRows.map((r) => r.candidateId)).size,
  };
}

/** Latest-version documents expiring within `withinDays` (soonest first); set includeExpired to also list lapsed ones. */
export async function listExpiringDocuments(
  actor: Actor & { timezone?: string },
  withinDays: number,
  opts: { includeExpired?: boolean } = {},
): Promise<QueueRow[]> {
  const { today, docRows } = await analyse(actor);
  return docRows
    .filter((r) => inWindow(r, today, withinDays) || (opts.includeExpired && r.status === "expired"))
    .sort((a, b) => (a.expiryDate ?? "").localeCompare(b.expiryDate ?? ""));
}

export interface QueueResult {
  rows: QueueRow[];
  total: number;
  counts: Record<QueueFilter, number>;
  page: number;
  pageSize: number;
}

/** Cross-candidate review queue for the Documents screen. Scoped to the actor's record-level access. */
export async function listDocumentQueue(
  actor: Actor & { timezone?: string },
  q: { filter: QueueFilter; withinDays?: number; q?: string; page?: number; pageSize?: number },
): Promise<QueueResult> {
  const { today, docRows, missingRows } = await analyse(actor);
  const within = q.withinDays ?? 30;
  const pick: Record<QueueFilter, QueueRow[]> = {
    awaiting: docRows.filter((r) => r.status === "pending_review").sort((a, b) => (a.uploadedAt ?? "").localeCompare(b.uploadedAt ?? "")),
    expiring: docRows.filter((r) => inWindow(r, today, within)).sort((a, b) => (a.expiryDate ?? "").localeCompare(b.expiryDate ?? "")),
    expired: docRows.filter((r) => r.status === "expired").sort((a, b) => (a.expiryDate ?? "").localeCompare(b.expiryDate ?? "")),
    rejected: docRows.filter((r) => r.status === "rejected").sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? "")),
    missing: missingRows.filter((r) => r.status === "not_uploaded").sort((a, b) => a.candidateName.localeCompare(b.candidateName)),
  };
  const counts = Object.fromEntries(Object.entries(pick).map(([k, v]) => [k, v.length])) as Record<QueueFilter, number>;
  const needle = q.q?.trim().toLowerCase();
  const all = needle
    ? pick[q.filter].filter((r) => r.candidateName.toLowerCase().includes(needle) || r.candidateCode.toLowerCase().includes(needle))
    : pick[q.filter];
  const pageSize = Math.min(100, q.pageSize ?? 50);
  const page = Math.max(1, q.page ?? 1);
  return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, counts, page, pageSize };
}
