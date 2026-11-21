import { randomUUID } from "node:crypto";
import { connectDb } from "@/lib/db/connect";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { User } from "@/lib/db/models/user";
import { nextSequence } from "@/lib/db/models/counter";
import { hmacHex } from "@/lib/crypto/keys";
import { protectField, revealField, type ProtectedField } from "@/lib/crypto/field";
import { audit } from "@/lib/audit";
import { assertCan, can, candidateScopeFilter, canAccessCandidate, ForbiddenError, type Actor } from "@/lib/rbac/can";
import { CANDIDATE_FIELD_RULES, stripRestricted } from "@/lib/rbac/mask";
import type { SessionUser } from "@/lib/auth/session";
import { raiseChangeReview, regenerateComplianceSchedule, type MaterialChangeField } from "@/lib/tasks/triggers";
import { ensureTrackerCycleFor } from "@/lib/tracker/service";
import { ASSIGNABLE_ROLES, userNameMap } from "@/lib/users/directory";
import { csvEscape } from "@/lib/csv";
import { CANDIDATE_STAGES } from "./constants";
import { IMMIGRATION_KEYS, SENSITIVE_KEYS, type CandidateInput, type CandidatePatch } from "./schema";

/** A business-rule violation the user can fix (HTTP 422) — as opposed to a bug. */
export class CandidateValidationError extends Error {
  status = 422;
  constructor(message: string) {
    super(message);
    this.name = "CandidateValidationError";
  }
}

export type DuplicateMatch = { id: string; code: string; name: string; email: string; reason: string };

export class DuplicateCandidateError extends Error {
  constructor(
    public kind: "hard" | "soft",
    public matches: DuplicateMatch[],
  ) {
    super(
      kind === "hard"
        ? "A candidate with the same email or SEVIS ID already exists."
        : "A candidate with the same name and date of birth may already exist.",
    );
    this.name = "DuplicateCandidateError";
  }
}

/* ------------------------------ duplicate keys ------------------------------ */

const lower = (s?: string | null) => (s ?? "").trim().toLowerCase();
/** Names compare case-, accent- and spacing-insensitively ("José  García" ≡ "jose garcia"). */
const normName = (s?: string | null) =>
  (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export const sevisHashOf = (sevis: string) => hmacHex("sevis", sevis.trim().toUpperCase());
export const nameDobHashOf = (name: string, dob: string) => hmacHex("namedob", `${normName(name)}|${dob}`);
/** Hash formula used before accents/spacing were normalised — still matched so older records keep being detected. */
const legacyNameDobHashOf = (name: string, dob: string) => hmacHex("namedob", `${lower(name)}|${dob}`);
const nameDobHashesOf = (name: string, dob: string) => [...new Set([nameDobHashOf(name, dob), legacyNameDobHashOf(name, dob)])];

export interface DuplicateProbe {
  email?: string;
  sevisId?: string;
  legalName?: string;
  dateOfBirth?: string;
  excludeId?: string;
}

/**
 * Finds existing candidates by email, SEVIS (HMAC) or name+DOB (HMAC). Never merges anything.
 * When `actor` is given, matches the actor may not access are REDACTED (no name/email/code), so duplicate detection
 * cannot be used to read candidates outside an associate's assignment.
 */
export async function findDuplicates(p: DuplicateProbe, actor?: Actor) {
  await connectDb();
  const or: Record<string, unknown>[] = [];
  if (p.email) or.push({ emailLower: lower(p.email) });
  if (p.sevisId) or.push({ sevisHash: sevisHashOf(p.sevisId) });
  const nameDob = p.legalName && p.dateOfBirth ? nameDobHashesOf(p.legalName, p.dateOfBirth) : [];
  if (nameDob.length) or.push({ nameDobHash: { $in: nameDob } });
  if (or.length === 0) return { hard: [] as DuplicateMatch[], soft: [] as DuplicateMatch[] };

  const rows = await Candidate.find({ $or: or, ...(p.excludeId ? { _id: { $ne: p.excludeId } } : {}) })
    .select("candidateCode legalName email emailLower sevisHash nameDobHash ownerId teamMemberIds")
    .lean<ICandidate[]>();
  const hard: DuplicateMatch[] = [];
  const soft: DuplicateMatch[] = [];
  for (const r of rows) {
    const visible = !actor || canAccessCandidate(actor, { ownerId: r.ownerId, teamMemberIds: r.teamMemberIds });
    const base: Omit<DuplicateMatch, "reason"> = visible
      ? { id: r._id, code: r.candidateCode, name: r.legalName, email: r.email }
      : { id: "", code: "—", name: "A candidate assigned to another owner", email: "" };
    if (p.email && r.emailLower === lower(p.email)) hard.push({ ...base, reason: "Same email" });
    else if (p.sevisId && r.sevisHash === sevisHashOf(p.sevisId)) hard.push({ ...base, reason: "Same SEVIS ID" });
    else soft.push({ ...base, reason: "Same name and date of birth" });
  }
  return { hard, soft };
}

/* --------------------------- assignment validation --------------------------- */

/** The compliance owner must be an ACTIVE user with a role that can own compliance work; a recruiter any active user. */
async function assertAssignable(userId: string | null | undefined, kind: "owner" | "recruiter") {
  if (!userId) return;
  await connectDb();
  const ok = await User.exists({ _id: userId, active: true, ...(kind === "owner" ? { role: { $in: ASSIGNABLE_ROLES } } : {}) });
  if (!ok) {
    throw new CandidateValidationError(
      kind === "owner" ? "The selected compliance owner is not an active compliance user." : "The selected recruiter is not an active user.",
    );
  }
}

/* --------------------------- input → document --------------------------- */

function toDoc(input: CandidatePatch, actor: Actor) {
  const doc: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined) doc[k] = v;
  };
  const passthrough = [
    "legalName", "preferredName", "phone", "country", "school", "campus", "degreeLevel", "degree", "major",
    "stemCipCode", "programStart", "programEnd", "graduationDate", "dsoName", "dsoEmail", "dsoPhone",
    "visaStatus", "authType", "eadCategory", "eadStart", "eadEnd", "i20IssueDate", "i20EndorsementDate",
    "receiptNumber", "caseStatus", "i983Status", "validationStatus", "reviewOutcome", "stage", "priority", "source",
  ] as const;
  for (const k of passthrough) set(k, (input as Record<string, unknown>)[k]);
  if (input.email) {
    doc.email = input.email;
    doc.emailLower = lower(input.email);
  }
  if (
    input.addressLine1 !== undefined || input.addressLine2 !== undefined || input.city !== undefined ||
    input.state !== undefined || input.postalCode !== undefined || input.addressCountry !== undefined
  ) {
    doc.address = {
      line1: input.addressLine1, line2: input.addressLine2, city: input.city,
      state: input.state, postalCode: input.postalCode, country: input.addressCountry,
    };
  }
  if (input.emergencyName !== undefined || input.emergencyPhone !== undefined || input.emergencyRelationship !== undefined) {
    doc.emergencyContact = { name: input.emergencyName, phone: input.emergencyPhone, relationship: input.emergencyRelationship };
  }
  if (input.tagsCsv !== undefined) {
    doc.tags = [...new Set(input.tagsCsv.split(",").map((t) => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
  }
  // protected identifiers — only if the actor may handle them
  if (input.sevisId && can(actor, SENSITIVE_KEYS.sevisId)) {
    doc.sevisId = protectField(input.sevisId);
    doc.sevisHash = sevisHashOf(input.sevisId);
  }
  if (input.eadNumber && can(actor, SENSITIVE_KEYS.eadNumber)) doc.eadNumber = protectField(input.eadNumber);
  if (input.dateOfBirth && can(actor, SENSITIVE_KEYS.dateOfBirth)) doc.dateOfBirth = protectField(input.dateOfBirth);
  return doc;
}

/** Safe snapshot for audit/diff: protected fields appear as masks only. */
function auditShape(c: Partial<ICandidate> | Record<string, unknown>) {
  const o = { ...(c as Record<string, unknown>) };
  for (const k of ["sevisId", "eadNumber", "dateOfBirth"]) {
    const p = o[k] as ProtectedField | undefined;
    if (p) o[k] = p.mask;
  }
  delete o.sevisHash;
  delete o.nameDobHash;
  delete o.notes;
  delete o.contactHistory;
  return o;
}

/* ------------------------------ create ------------------------------ */

export async function createCandidate(actor: SessionUser, input: CandidateInput, opts: { allowSoftDuplicate?: boolean } = {}) {
  assertCan(actor, "candidates.create");
  await connectDb();

  const dobAllowed = !!input.dateOfBirth && can(actor, "sensitive.dob.view");
  const dups = await findDuplicates(
    {
      email: input.email,
      sevisId: can(actor, "sensitive.sevis.view") ? input.sevisId : undefined,
      legalName: input.legalName,
      dateOfBirth: dobAllowed ? input.dateOfBirth : undefined,
    },
    actor,
  );
  if (dups.hard.length) throw new DuplicateCandidateError("hard", dups.hard);
  if (dups.soft.length && !opts.allowSoftDuplicate) throw new DuplicateCandidateError("soft", dups.soft);

  const doc = toDoc(input, actor);
  if (dobAllowed) doc.nameDobHash = nameDobHashOf(input.legalName, input.dateOfBirth!);
  if (!can(actor, "immigration.edit")) {
    for (const k of IMMIGRATION_KEYS) delete doc[k as string];
    delete doc.sevisId; delete doc.sevisHash; delete doc.eadNumber;
  }
  if (!can(actor, "candidates.assign")) {
    // creators without assign rights own what they create (so assigned-only roles can see their own records)
    doc.ownerId = actor.id;
  } else {
    await assertAssignable(input.ownerId, "owner");
    await assertAssignable(input.recruiterId, "recruiter");
    doc.ownerId = input.ownerId || actor.id;
    if (input.recruiterId) doc.recruiterId = input.recruiterId;
  }

  try {
    const code = `CND-${String(await nextSequence("candidate")).padStart(6, "0")}`;
    const created = await Candidate.create({ ...doc, candidateCode: code, createdBy: actor.id, updatedBy: actor.id });
    await audit({
      actor, action: "create", entityType: "candidate", entityId: created._id, candidateId: created._id,
      summary: `Created candidate ${code} (${created.legalName})`, after: auditShape(created.toObject()),
    });
    await regenerateComplianceSchedule({ actor, candidateId: created._id });
    return created.toObject() as ICandidate;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      // lost a race with a concurrent create: re-probe and report the duplicate properly
      const again = await findDuplicates({ email: input.email, sevisId: input.sevisId }, actor);
      throw new DuplicateCandidateError("hard", again.hard);
    }
    throw err;
  }
}

/* ------------------------------ update ------------------------------ */

const MATERIAL_MAP: { key: string; field: MaterialChangeField }[] = [{ key: "address", field: "address" }];

/** Plain optional fields that may be blanked by submitting an empty value (protected identifiers are never cleared this way). */
const CLEARABLE = [
  "preferredName", "phone", "country", "school", "campus", "degreeLevel", "degree", "major", "stemCipCode",
  "programStart", "programEnd", "graduationDate", "dsoName", "dsoEmail", "dsoPhone", "eadCategory", "eadStart",
  "eadEnd", "i20EndorsementDate", "i20IssueDate", "receiptNumber", "caseStatus", "validationStatus", "reviewOutcome", "source",
];
const CLEARABLE_IMMIGRATION = new Set(["eadCategory", "eadStart", "eadEnd", "i20IssueDate", "i20EndorsementDate", "receiptNumber", "caseStatus", "validationStatus", "reviewOutcome"]);

export async function updateCandidate(
  actor: SessionUser,
  id: string,
  input: CandidatePatch,
  opts: { clear?: string[]; allowSoftDuplicate?: boolean } = {},
) {
  assertCan(actor, "candidates.edit");
  await connectDb();
  const existing = await Candidate.findById(id);
  if (!existing || !canAccessCandidate(actor, { ownerId: existing.ownerId, teamMemberIds: existing.teamMemberIds })) {
    throw new ForbiddenError("Candidate not found.");
  }
  const before = auditShape(existing.toObject());

  const doc = toDoc(input, actor);
  if (!can(actor, "immigration.edit")) {
    for (const k of IMMIGRATION_KEYS) delete doc[k as string];
    delete doc.sevisId; delete doc.sevisHash; delete doc.eadNumber;
  }
  if (can(actor, "candidates.assign")) {
    if (input.ownerId !== undefined) {
      await assertAssignable(input.ownerId, "owner");
      doc.ownerId = input.ownerId || null;
    }
    if (input.recruiterId !== undefined) {
      await assertAssignable(input.recruiterId, "recruiter");
      doc.recruiterId = input.recruiterId || null;
    }
    // the edit form submits "" for "— unassigned —" / "— none —"
    if (opts.clear?.includes("ownerId")) doc.ownerId = null;
    if (opts.clear?.includes("recruiterId")) doc.recruiterId = null;
  }

  // duplicate re-check on identifiers that changed
  const probe: DuplicateProbe = { excludeId: id };
  if (doc.emailLower && doc.emailLower !== existing.emailLower) probe.email = doc.emailLower as string;
  if (input.sevisId && doc.sevisHash && doc.sevisHash !== existing.sevisHash) probe.sevisId = input.sevisId;
  if (probe.email || probe.sevisId) {
    const dups = await findDuplicates(probe, actor);
    if (dups.hard.length) throw new DuplicateCandidateError("hard", dups.hard);
  }

  // Keep the name+DOB duplicate key correct. The DOB is encrypted and blank in the edit form ("keep current"), so when
  // only the NAME changes the stored DOB is decrypted internally to recompute the hash — otherwise it would go stale and
  // later duplicate checks would silently miss this candidate. A name/DOB change is also re-checked for duplicates.
  const newDob = doc.dateOfBirth && input.dateOfBirth ? input.dateOfBirth : undefined;
  const nameChanged = !!doc.legalName && normName(doc.legalName as string) !== normName(existing.legalName);
  if (newDob || nameChanged) {
    let dob = newDob;
    if (!dob && existing.dateOfBirth) {
      try {
        dob = revealField(existing.dateOfBirth);
      } catch {
        dob = undefined;
      }
    }
    if (dob) {
      const name = (doc.legalName as string | undefined) ?? existing.legalName;
      doc.nameDobHash = nameDobHashOf(name, dob);
      const dups = await findDuplicates({ legalName: name, dateOfBirth: dob, excludeId: id }, actor);
      if (dups.soft.length && !opts.allowSoftDuplicate) throw new DuplicateCandidateError("soft", dups.soft);
    }
  }

  for (const k of opts.clear ?? []) {
    if (!CLEARABLE.includes(k)) continue;
    if (CLEARABLE_IMMIGRATION.has(k) && !can(actor, "immigration.edit")) continue;
    doc[k] = undefined;
  }

  existing.set({ ...doc, updatedBy: actor.id });
  const addressChanged = existing.isModified("address");
  const datesChanged = ["eadStart", "eadEnd", "authType", "graduationDate", "stage"].some((k) => existing.isModified(k));
  await existing.save();

  const after = auditShape(existing.toObject());
  const changed: Record<string, unknown> = {};
  const prior: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (k === "updatedAt" || k === "updatedBy") continue;
    if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) {
      changed[k] = after[k];
      prior[k] = before[k];
    }
  }
  if (Object.keys(changed).length) {
    await audit({
      actor, action: "update", entityType: "candidate", entityId: id, candidateId: id,
      summary: `Updated ${Object.keys(changed).join(", ")}`, before: prior, after: changed,
    });
  }
  if ("stage" in changed) {
    await audit({
      actor, action: "status_change", entityType: "candidate", entityId: id, candidateId: id,
      summary: `Stage ${String(prior.stage)} → ${String(changed.stage)}`, before: { stage: prior.stage }, after: { stage: changed.stage },
    });
  }
  if (addressChanged) {
    await raiseChangeReview({ actor, candidateId: id, fields: MATERIAL_MAP.map((m) => m.field), summary: "Candidate address changed — review whether DSO reporting is needed." });
  }
  if (datesChanged) await regenerateComplianceSchedule({ actor, candidateId: id });
  return existing.toObject() as ICandidate;
}

/* ------------------------------- views ------------------------------- */

export type CandidateView = Omit<ICandidate, "sevisId" | "eadNumber" | "dateOfBirth" | "sevisHash" | "nameDobHash"> & {
  sevisId?: string; // mask only
  eadNumber?: string;
  dateOfBirth?: string;
};

/** Serializable, permission-trimmed candidate for pages/APIs. Ciphertext never leaves the server. */
export function toCandidateView(actor: Actor, c: ICandidate): Partial<CandidateView> {
  const plain: Record<string, unknown> = { ...c };
  for (const k of ["sevisId", "eadNumber", "dateOfBirth"] as const) {
    const p = c[k];
    plain[k] = p?.mask;
  }
  delete plain.sevisHash;
  delete plain.nameDobHash;
  const trimmed = stripRestricted(actor, plain, CANDIDATE_FIELD_RULES);
  if (!can(actor, "immigration.view")) {
    for (const k of [
      "authType", "eadCategory", "eadStart", "eadEnd", "i20IssueDate", "i20EndorsementDate", "caseStatus",
      "i983Status", "validationStatus", "reviewOutcome", "visaStatus", "clearedToWork", "riskFlags",
    ]) delete (trimmed as Record<string, unknown>)[k];
  }
  if (!can(actor, "candidates.edit")) delete (trimmed as Record<string, unknown>).emergencyContact;
  return JSON.parse(JSON.stringify(trimmed));
}

/** Reveal a protected identifier — separate permission, always audit-logged (long spec §6, §9). */
export async function revealSensitive(actor: SessionUser, candidateId: string, field: "sevisId" | "eadNumber" | "dateOfBirth") {
  const perm = field === "sevisId" ? "sensitive.sevis.view" : field === "eadNumber" ? "sensitive.ead.view" : "sensitive.dob.view";
  assertCan(actor, perm);
  await connectDb();
  const c = await Candidate.findById(candidateId).lean<ICandidate>();
  if (!c || !canAccessCandidate(actor, { ownerId: c.ownerId, teamMemberIds: c.teamMemberIds })) throw new ForbiddenError("Candidate not found.");
  const value = revealField(c[field]);
  await audit({
    actor, action: "reveal_sensitive", entityType: "candidate", entityId: candidateId, candidateId,
    summary: `Revealed ${field}`,
  });
  return value ?? "";
}

/* ------------------------------- listing ------------------------------- */

export interface CandidateListQuery {
  q?: string;
  stage?: string;
  authType?: string;
  ownerId?: string;
  tag?: string;
  dueBefore?: string;
  risk?: boolean;
  sort?: "name" | "-name" | "due" | "-created" | "code";
  page?: number;
  pageSize?: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildCandidateFilter(actor: Actor, q: CandidateListQuery): Record<string, unknown> {
  const and: Record<string, unknown>[] = [candidateScopeFilter(actor)];
  if (q.q?.trim()) {
    const re = new RegExp(escapeRe(q.q.trim().slice(0, 80)), "i");
    and.push({ $or: [{ legalName: re }, { preferredName: re }, { emailLower: re }, { candidateCode: re }, { school: re }, { phone: re }] });
  }
  if (q.stage) and.push({ stage: String(q.stage) });
  if (q.authType && can(actor, "immigration.view")) and.push({ authType: String(q.authType) });
  if (q.ownerId) and.push({ ownerId: q.ownerId === "unassigned" ? null : String(q.ownerId) });
  if (q.tag) and.push({ tags: String(q.tag) });
  if (q.dueBefore) and.push({ nextDueDate: { $ne: null, $lte: String(q.dueBefore) } });
  if (q.risk && can(actor, "immigration.view")) and.push({ "riskFlags.0": { $exists: true } });
  return and.length === 1 ? and[0] : { $and: and };
}

/** `_id` is the final tie-breaker so paging is stable: no row is repeated or skipped between pages when sort keys tie. */
const SORTS: Record<NonNullable<CandidateListQuery["sort"]>, Record<string, 1 | -1>> = {
  name: { legalName: 1, _id: 1 },
  "-name": { legalName: -1, _id: 1 },
  due: { legalName: 1, _id: 1 }, // handled by the aggregation below (candidates with no due date sort LAST)
  "-created": { createdAt: -1, _id: 1 },
  code: { candidateCode: 1, _id: 1 },
};
/** Case-insensitive ordering ("anna" sorts with "Anna", not after "Zoe"). */
const COLLATION = { locale: "en", strength: 2 } as const;
/** The list never needs the (potentially long) note / contact histories. */
const LIST_PROJECTION = { notes: 0, contactHistory: 0 } as const;

export async function listCandidates(actor: SessionUser, q: CandidateListQuery) {
  assertCan(actor, "candidates.view");
  await connectDb();
  const page = Math.max(1, Math.floor(q.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(q.pageSize ?? 25) || 25));
  const filter = buildCandidateFilter(actor, q);
  const sort = q.sort && q.sort in SORTS ? q.sort : "-created";

  const fetchRows =
    sort === "due"
      ? Candidate.aggregate<ICandidate>([
          { $match: filter },
          { $addFields: { _dueSort: { $ifNull: ["$nextDueDate", "9999-12-31"] } } },
          { $sort: { _dueSort: 1, legalName: 1, _id: 1 } },
          { $skip: (page - 1) * pageSize },
          { $limit: pageSize },
          { $project: { ...LIST_PROJECTION, _dueSort: 0 } },
        ]).collation(COLLATION)
      : Candidate.find(filter, LIST_PROJECTION)
          .sort(SORTS[sort])
          .collation(COLLATION)
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .lean<ICandidate[]>();

  const [rows, total] = await Promise.all([fetchRows, Candidate.countDocuments(filter)]);
  return { rows: (rows as ICandidate[]).map((r) => toCandidateView(actor, r)), total, page, pageSize };
}

/* ------------------------ notes & contact history ------------------------ */

export async function addNote(actor: SessionUser, candidateId: string, text: string) {
  assertCan(actor, "candidates.edit");
  await connectDb();
  const c = await Candidate.findById(candidateId).select("ownerId teamMemberIds").lean<ICandidate>();
  if (!c || !canAccessCandidate(actor, c)) throw new ForbiddenError("Candidate not found.");
  await Candidate.updateOne({ _id: candidateId }, { $push: { notes: { $each: [{ _id: randomUUID(), text: text.trim().slice(0, 4000), authorId: actor.id, authorName: actor.name, createdAt: new Date() }], $position: 0 } } });
  await audit({ actor, action: "create", entityType: "candidate_note", entityId: candidateId, candidateId, summary: "Added case note" });
}

export async function addContactEntry(actor: SessionUser, candidateId: string, channel: string, summary: string) {
  assertCan(actor, "candidates.edit");
  await connectDb();
  const c = await Candidate.findById(candidateId).select("ownerId teamMemberIds").lean<ICandidate>();
  if (!c || !canAccessCandidate(actor, c)) throw new ForbiddenError("Candidate not found.");
  await Candidate.updateOne({ _id: candidateId }, { $push: { contactHistory: { $each: [{ _id: randomUUID(), channel, summary: summary.trim().slice(0, 2000), byId: actor.id, byName: actor.name, at: new Date() }], $position: 0 } } });
  await audit({ actor, action: "create", entityType: "candidate_contact", entityId: candidateId, candidateId, summary: `Logged ${channel} contact` });
}

/* ----------------------------- bulk actions ----------------------------- */

export const BULK_MAX = 500;

export interface BulkResult {
  /** candidates found within the actor's access scope */
  matched: number;
  /** of those, how many actually changed */
  modified: number;
  /** requested ids that do not exist or the actor may not access (never revealed which) */
  skipped: number;
}

/**
 * Bulk owner / stage / tag changes. Everything is validated server-side (the UI is not trusted), limited to the actor's
 * own scope, and audited with the affected ids. Moving candidates to Onboarding/Active starts their 12-month cycle.
 */
export async function bulkUpdate(
  actor: SessionUser,
  ids: string[],
  change: { ownerId?: string | null; stage?: string; addTag?: string },
): Promise<BulkResult> {
  assertCan(actor, "candidates.edit");
  if (change.ownerId !== undefined) assertCan(actor, "candidates.assign");
  const unique = [...new Set(ids.map(String))];
  if (unique.length === 0) throw new CandidateValidationError("Select at least one candidate.");
  if (unique.length > BULK_MAX) throw new CandidateValidationError(`Select at most ${BULK_MAX} candidates at a time.`);
  const tag = change.addTag?.trim().slice(0, 40);
  if (change.stage !== undefined && !(CANDIDATE_STAGES as readonly string[]).includes(change.stage)) {
    throw new CandidateValidationError("Unknown stage.");
  }
  if (change.addTag !== undefined && !tag) throw new CandidateValidationError("Enter a tag.");
  if (change.ownerId === undefined && !change.stage && !tag) throw new CandidateValidationError("Choose a change to apply.");
  if (change.ownerId) await assertAssignable(change.ownerId, "owner");

  await connectDb();
  const inScope = await Candidate.find({ _id: { $in: unique }, ...candidateScopeFilter(actor) }).select("_id").lean<{ _id: string }[]>();
  const matchedIds = inScope.map((c) => c._id);
  if (matchedIds.length === 0) return { matched: 0, modified: 0, skipped: unique.length };

  const set: Record<string, unknown> = { updatedBy: actor.id };
  if (change.ownerId !== undefined) set.ownerId = change.ownerId || null;
  if (change.stage) set.stage = change.stage;
  const update: Record<string, unknown> = { $set: set };
  if (tag) update.$addToSet = { tags: tag };
  const res = await Candidate.updateMany({ _id: { $in: matchedIds } }, update);

  await audit({
    actor,
    action: change.stage ? "status_change" : "update",
    entityType: "candidate",
    summary: `Bulk update on ${matchedIds.length} candidate${matchedIds.length === 1 ? "" : "s"}: ${[
      change.ownerId !== undefined ? `owner → ${change.ownerId || "unassigned"}` : "",
      change.stage ? `stage → ${change.stage}` : "",
      tag ? `tag "${tag}"` : "",
    ].filter(Boolean).join(", ")}`,
    after: { change, matched: matchedIds.length, modified: res.modifiedCount, candidateIds: matchedIds.slice(0, 200) },
  });

  if (change.stage === "onboarding" || change.stage === "active") {
    for (const id of matchedIds) await ensureTrackerCycleFor(id); // idempotent; never throws
  }
  return { matched: matchedIds.length, modified: res.modifiedCount, skipped: unique.length - matchedIds.length };
}

/* --------------------------------- export --------------------------------- */

export const EXPORT_MAX_ROWS = 10_000;

interface ExportColumn {
  key: string;
  /** Header text. Chosen to match the import template so an export can be re-imported/mapped automatically. */
  label: string;
  /** Needs this permission, else the column is left out entirely. */
  needs?: "immigration.view";
  /** Protected identifier: only exported on explicit request AND with its own permission. */
  sensitive?: "sensitive.sevis.view" | "sensitive.ead.view" | "sensitive.dob.view";
  get: (c: ICandidate, ctx: { owners: Record<string, string> }) => unknown;
}

const EXPORT_COLUMNS: ExportColumn[] = [
  { key: "candidateCode", label: "Candidate ID", get: (c) => c.candidateCode },
  { key: "legalName", label: "Legal Name", get: (c) => c.legalName },
  { key: "preferredName", label: "Preferred Name", get: (c) => c.preferredName },
  { key: "email", label: "Email", get: (c) => c.email },
  { key: "phone", label: "Phone", get: (c) => c.phone },
  { key: "country", label: "Country", get: (c) => c.country },
  { key: "addressLine1", label: "Address Line 1", get: (c) => c.address?.line1 },
  { key: "addressLine2", label: "Address Line 2", get: (c) => c.address?.line2 },
  { key: "city", label: "City", get: (c) => c.address?.city },
  { key: "state", label: "State", get: (c) => c.address?.state },
  { key: "postalCode", label: "Postal Code", get: (c) => c.address?.postalCode },
  { key: "addressCountry", label: "Address Country", get: (c) => c.address?.country },
  { key: "school", label: "School", get: (c) => c.school },
  { key: "campus", label: "Campus", get: (c) => c.campus },
  { key: "degreeLevel", label: "Degree Level", get: (c) => c.degreeLevel },
  { key: "degree", label: "Degree", get: (c) => c.degree },
  { key: "major", label: "Major", get: (c) => c.major },
  { key: "stemCipCode", label: "STEM CIP Code", get: (c) => c.stemCipCode },
  { key: "programStart", label: "Program Start", get: (c) => c.programStart },
  { key: "programEnd", label: "Program End", get: (c) => c.programEnd },
  { key: "graduationDate", label: "Graduation Date", get: (c) => c.graduationDate },
  { key: "dsoName", label: "DSO Name", needs: "immigration.view", get: (c) => c.dsoName },
  { key: "dsoEmail", label: "DSO Email", needs: "immigration.view", get: (c) => c.dsoEmail },
  { key: "dsoPhone", label: "DSO Phone", needs: "immigration.view", get: (c) => c.dsoPhone },
  { key: "visaStatus", label: "Visa Status", needs: "immigration.view", get: (c) => c.visaStatus },
  { key: "authType", label: "Authorization Type", needs: "immigration.view", get: (c) => (c.authType === "none" ? "" : c.authType) },
  { key: "eadCategory", label: "EAD Category", needs: "immigration.view", get: (c) => c.eadCategory },
  { key: "eadStart", label: "EAD Start", needs: "immigration.view", get: (c) => c.eadStart },
  { key: "eadEnd", label: "EAD End", needs: "immigration.view", get: (c) => c.eadEnd },
  { key: "i20IssueDate", label: "I-20 Issue Date", needs: "immigration.view", get: (c) => c.i20IssueDate },
  { key: "i20EndorsementDate", label: "I-20 Endorsement Date", needs: "immigration.view", get: (c) => c.i20EndorsementDate },
  { key: "i983Status", label: "I-983 Status", needs: "immigration.view", get: (c) => (c.i983Status === "not_applicable" ? "" : c.i983Status) },
  { key: "clearedToWork", label: "Cleared To Work", needs: "immigration.view", get: (c) => (c.clearedToWork ? "Yes" : "No") },
  { key: "stage", label: "Stage", get: (c) => c.stage },
  { key: "priority", label: "Priority", get: (c) => c.priority },
  { key: "owner", label: "Compliance Owner", get: (c, x) => (c.ownerId ? (x.owners[c.ownerId] ?? "") : "") },
  { key: "recruiter", label: "Recruiter", get: (c, x) => (c.recruiterId ? (x.owners[c.recruiterId] ?? "") : "") },
  { key: "nextDueDate", label: "Next Due Date", get: (c) => c.nextDueDate },
  { key: "tags", label: "Tags", get: (c) => (c.tags ?? []).join("; ") },
  { key: "source", label: "Source", get: (c) => c.source },
  { key: "createdAt", label: "Created", get: (c) => (c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "") },
  // protected identifiers — excluded unless explicitly requested by someone holding the matching permission
  { key: "dateOfBirth", label: "Date of Birth", sensitive: "sensitive.dob.view", get: (c) => (c.dateOfBirth ? safeReveal(c.dateOfBirth) : "") },
  { key: "sevisId", label: "SEVIS ID", sensitive: "sensitive.sevis.view", get: (c) => (c.sevisId ? safeReveal(c.sevisId) : "") },
  { key: "eadNumber", label: "EAD Number", sensitive: "sensitive.ead.view", get: (c) => (c.eadNumber ? safeReveal(c.eadNumber) : "") },
];

function safeReveal(p: ProtectedField): string {
  try {
    return revealField(p) ?? "";
  } catch {
    return "";
  }
}

export interface CandidateExport {
  csv: string;
  count: number;
  truncated: boolean;
  columns: string[];
  /** protected columns that were actually included */
  sensitiveIncluded: string[];
}

/**
 * CSV export of EXACTLY the candidates the list would show for the same filters, limited to the actor's access scope.
 * Restricted columns are left out unless `includeSensitive` is requested and the actor holds that field's permission;
 * any export is audited (and a restricted export is additionally logged as a sensitive reveal).
 */
export async function exportCandidates(actor: SessionUser, q: CandidateListQuery, opts: { includeSensitive?: boolean } = {}): Promise<CandidateExport> {
  assertCan(actor, "candidates.export");
  await connectDb();
  const filter = buildCandidateFilter(actor, q);
  const [rows, total] = await Promise.all([
    Candidate.find(filter).sort({ candidateCode: 1 }).collation(COLLATION).limit(EXPORT_MAX_ROWS).lean<ICandidate[]>(),
    Candidate.countDocuments(filter),
  ]);
  const owners = await userNameMap(rows.flatMap((r) => [r.ownerId, r.recruiterId]));

  const cols = EXPORT_COLUMNS.filter((c) => {
    if (c.sensitive) return !!opts.includeSensitive && can(actor, c.sensitive);
    if (c.needs) return can(actor, c.needs);
    return true;
  });
  const lines = [cols.map((c) => csvEscape(c.label)).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(c.get(r, { owners }))).join(","));

  const sensitiveIncluded = cols.filter((c) => c.sensitive).map((c) => c.key);
  const truncated = total > rows.length;
  await audit({
    actor,
    action: "export",
    entityType: "candidate",
    summary: `Exported ${rows.length} candidate${rows.length === 1 ? "" : "s"} to CSV${sensitiveIncluded.length ? ` including restricted fields (${sensitiveIncluded.join(", ")})` : ""}${truncated ? ` — truncated at ${EXPORT_MAX_ROWS} of ${total}` : ""}`,
    after: { filters: Object.fromEntries(Object.entries(q).filter(([k, v]) => v !== undefined && v !== "" && k !== "page" && k !== "pageSize")), count: rows.length, columns: cols.map((c) => c.key), sensitiveIncluded },
  });
  if (sensitiveIncluded.length) {
    await audit({
      actor, action: "reveal_sensitive", entityType: "candidate",
      summary: `Bulk-exported restricted fields (${sensitiveIncluded.join(", ")}) for ${rows.length} candidates`,
    });
  }
  return { csv: lines.join("\r\n"), count: rows.length, truncated, columns: cols.map((c) => c.key), sensitiveIncluded };
}

export const EXPORT_SENSITIVE_PERMISSIONS = ["sensitive.sevis.view", "sensitive.ead.view", "sensitive.dob.view"] as const;
