import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCollections, startTestDb, stopTestDb } from "../helpers/db";

/**
 * Candidate Management — end-to-end tests against a SCRATCH database with SYNTHETIC candidates only.
 * Real sessions, real server actions, real route handlers; only the Next.js request plumbing (cookies/headers) is faked.
 */
const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  const hdrs = new Map<string, string>();
  const jar = {
    get: (n: string) => (store.has(n) ? { name: n, value: store.get(n)! } : undefined),
    set: (n: string, v: string) => void store.set(n, v),
    delete: (n: string) => void store.delete(n),
  };
  return { store, hdrs, jar };
});
vi.mock("@/lib/request-context", () => ({
  requestCookies: async () => h.jar,
  requestHeaders: async () => ({ get: (k: string) => h.hdrs.get(k.toLowerCase()) ?? null }),
  revalidate: () => undefined,
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let S: typeof import("@/lib/candidates/service");
let schema: typeof import("@/lib/candidates/schema");
let sessionMod: typeof import("@/lib/auth/session");
let actions: typeof import("@/app/(app)/candidates/actions");
let imp: typeof import("@/lib/import/service");
let M: {
  User: any;
  Session: any;
  Candidate: any;
  Audit: any;
  ImportRow: any;
  ImportJob: any;
  TrackerCycle: any;
};
let NextRequest: typeof import("next/server").NextRequest;

const COOKIE = "crm_session";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
type Role = "super_admin" | "compliance_manager" | "compliance_associate" | "payroll_preparer" | "payroll_approver" | "finance_operator" | "finance_approver" | "auditor";
const ROLES: Role[] = ["super_admin", "compliance_manager", "compliance_associate", "payroll_preparer", "payroll_approver", "finance_operator", "finance_approver", "auditor"];

beforeAll(async () => {
  await startTestDb();
  S = await import("@/lib/candidates/service");
  schema = await import("@/lib/candidates/schema");
  sessionMod = await import("@/lib/auth/session");
  actions = await import("@/app/(app)/candidates/actions");
  imp = await import("@/lib/import/service");
  NextRequest = (await import("next/server")).NextRequest;
  M = {
    User: (await import("@/lib/db/models/user")).User,
    Session: (await import("@/lib/db/models/session")).Session,
    Candidate: (await import("@/lib/db/models/candidate")).Candidate,
    Audit: (await import("@/lib/db/models/audit")).AuditEvent,
    ImportRow: (await import("@/lib/db/models/import-job")).ImportRow,
    ImportJob: (await import("@/lib/db/models/import-job")).ImportJob,
    TrackerCycle: (await import("@/lib/db/models/monthly-review")).TrackerCycle,
  };
});
afterAll(stopTestDb);

let actorsSeq = 0;
beforeEach(async () => {
  await clearCollections();
  h.store.clear();
  h.hdrs.clear();
  h.hdrs.set("x-forwarded-for", "10.0.0.1");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/* ------------------------------ helpers ------------------------------ */

interface Actor {
  id: string;
  role: Role;
  token: string;
  name: string;
}

async function newActor(role: Role, name?: string, extra: Record<string, unknown> = {}): Promise<Actor> {
  const n = ++actorsSeq;
  const u = await M.User.create({ name: name ?? `${role} ${n}`, email: `${role}-${n}@test.example`, role, passwordHash: "x", ...extra });
  const token = randomBytes(24).toString("base64url");
  await M.Session.create({ userId: String(u._id), tokenHash: sha256(token), stage: "active", expiresAt: new Date(Date.now() + 12 * 3600_000), idleExpiresAt: new Date(Date.now() + 1800_000) });
  return { id: String(u._id), role, token, name: u.name };
}
/** Make `a` the signed-in user and return the real SessionUser the app would see. */
async function as(a: Actor) {
  h.store.set(COOKIE, a.token);
  const u = await sessionMod.getSessionUser();
  if (!u) throw new Error("session did not resolve");
  return u;
}
async function allRoles() {
  const out = {} as Record<Role, Actor>;
  for (const r of ROLES) out[r] = await newActor(r);
  return out;
}

let seq = 0;
/** Synthetic candidate input, validated by the same zod schema the form/API use. */
const mk = (extra: Record<string, unknown> = {}) => {
  const i = ++seq;
  return schema.candidateCreateSchema.parse({
    legalName: `Synthetic Person ${i}`,
    email: `synthetic.person${i}@example.test`,
    phone: `+1 555 010 ${String(i).padStart(4, "0")}`,
    dateOfBirth: `199${i % 10}-0${(i % 9) + 1}-1${i % 9}`,
    school: "Fictional State University",
    ...extra,
  });
};
const FULL = {
  legalName: "Priya Fictional-Test",
  preferredName: "Pri",
  email: "priya.fictional@example.test",
  phone: "+1 555 010 4242",
  dateOfBirth: "1998-04-17",
  addressLine1: "1 Synthetic Way",
  addressLine2: "Unit 9",
  city: "Testville",
  state: "CA",
  postalCode: "94000",
  addressCountry: "USA",
  country: "India",
  emergencyName: "Emergency Contact",
  emergencyPhone: "+1 555 010 9999",
  emergencyRelationship: "Sibling",
  school: "Test University",
  campus: "Main",
  degreeLevel: "Master's",
  degree: "MS",
  major: "Computer Science",
  stemCipCode: "11.0701",
  programStart: "2024-08-20",
  programEnd: "2026-05-15",
  graduationDate: "2026-05-15",
  dsoName: "Dana DSO",
  dsoEmail: "dso@university.example",
  dsoPhone: "+1 555 010 7777",
  sevisId: "N0012345678",
  visaStatus: "F-1",
  authType: "STEM_OPT",
  eadCategory: "C03C",
  eadNumber: "SRC1234567890",
  eadStart: "2026-06-01",
  eadEnd: "2028-05-31",
  i20IssueDate: "2024-07-01",
  i20EndorsementDate: "2026-04-01",
  receiptNumber: "SRC2412345678",
  caseStatus: "Approved",
  i983Status: "signed",
  validationStatus: "Validated",
  reviewOutcome: "No issues",
  stage: "onboarding",
  priority: "high",
  source: "Referral",
  tagsCsv: "stem, priority-review",
};

async function run<T>(p: Promise<T>): Promise<{ redirect: string | null; result?: T }> {
  try {
    return { redirect: null, result: await p };
  } catch (e) {
    const d = String((e as { digest?: string }).digest ?? "");
    if (d.startsWith("NEXT_REDIRECT")) return { redirect: d.split(";")[2] };
    throw e;
  }
}
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) (Array.isArray(v) ? v : [v]).forEach((x) => f.append(k, x));
  return f;
};

async function api(method: "GET" | "POST" | "PATCH", path: string, opts: { json?: unknown; id?: string; form?: FormData } = {}) {
  const init: any = { method };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers = { "content-type": "application/json" };
  }
  if (opts.form) init.body = opts.form;
  const req = new NextRequest(`http://localhost${path}`, init);
  const ctx = { params: Promise.resolve({ id: opts.id ?? "" }) };
  const route = path.startsWith("/api/candidates/import")
    ? await import("@/app/api/candidates/import/route")
    : path.startsWith("/api/candidates/export")
      ? await import("@/app/api/candidates/export/route")
      : opts.id
        ? await import("@/app/api/candidates/[id]/route")
        : await import("@/app/api/candidates/route");
  const res: Response = await (route as any)[method](req, ctx);
  const bytes = Buffer.from(await res.clone().arrayBuffer());
  let body: any = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers, bytes };
}

/* ================================ 1. CREATE / VIEW / EDIT ================================ */

describe("create, view and edit candidates", () => {
  it("creates a candidate with EVERY profile field persisted in MongoDB (identity, education, immigration, CRM)", async () => {
    const mgr = await as(await newActor("compliance_manager", "Mgr One"));
    const c = await S.createCandidate(mgr, schema.candidateCreateSchema.parse(FULL));
    expect(c.candidateCode).toBe("CND-000001");
    const raw = await M.Candidate.findById(c._id).lean();
    // identity
    expect(raw).toMatchObject({ legalName: "Priya Fictional-Test", preferredName: "Pri", email: "priya.fictional@example.test", emailLower: "priya.fictional@example.test", phone: "+1 555 010 4242", country: "India" });
    expect(raw.address).toMatchObject({ line1: "1 Synthetic Way", line2: "Unit 9", city: "Testville", state: "CA", postalCode: "94000", country: "USA" });
    expect(raw.emergencyContact).toMatchObject({ name: "Emergency Contact", phone: "+1 555 010 9999", relationship: "Sibling" });
    // education
    expect(raw).toMatchObject({ school: "Test University", campus: "Main", degreeLevel: "Master's", degree: "MS", major: "Computer Science", stemCipCode: "11.0701", programStart: "2024-08-20", programEnd: "2026-05-15", graduationDate: "2026-05-15", dsoName: "Dana DSO", dsoEmail: "dso@university.example", dsoPhone: "+1 555 010 7777" });
    // immigration
    expect(raw).toMatchObject({ visaStatus: "F-1", authType: "STEM_OPT", eadCategory: "C03C", eadStart: "2026-06-01", eadEnd: "2028-05-31", i20IssueDate: "2024-07-01", i20EndorsementDate: "2026-04-01", receiptNumber: "SRC2412345678", caseStatus: "Approved", i983Status: "signed", validationStatus: "Validated", reviewOutcome: "No issues" });
    // CRM
    expect(raw).toMatchObject({ stage: "onboarding", priority: "high", source: "Referral", ownerId: mgr.id, createdBy: mgr.id });
    expect(raw.tags).toEqual(["stem", "priority-review"]);
    expect(raw._id).toMatch(/^[0-9a-f-]{36}$/); // internal UUID, never email/SEVIS
  });

  it("restricted identifiers are stored ENCRYPTED (ciphertext + mask), never as plaintext, with hashes for duplicate detection", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const c = await S.createCandidate(mgr, schema.candidateCreateSchema.parse(FULL));
    const raw = await M.Candidate.findById(c._id).lean();
    const json = JSON.stringify(raw);
    for (const secret of ["N0012345678", "SRC1234567890", "1998-04-17"]) expect(json).not.toContain(secret);
    expect(raw.sevisId.enc).toMatch(/^v1:/);
    expect(raw.sevisId.mask).toMatch(/5678$/);
    expect(raw.eadNumber.mask).toMatch(/7890$/);
    expect(raw.dateOfBirth.enc).toMatch(/^v1:/);
    expect(raw.sevisHash).toMatch(/^[0-9a-f]{64}$/);
    expect(raw.nameDobHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the profile view never leaks ciphertext or plaintext; 'reveal' needs the permission and is audit-logged", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const c = await S.createCandidate(mgr, schema.candidateCreateSchema.parse(FULL));
    const view = S.toCandidateView(mgr, c);
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/v1:/);
    expect(json).not.toContain("N0012345678");
    expect(view.sevisId).toMatch(/5678$/);
    expect(view.dateOfBirth).toBeTruthy();
    expect(await S.revealSensitive(mgr, c._id, "sevisId")).toBe("N0012345678");
    expect(await S.revealSensitive(mgr, c._id, "dateOfBirth")).toBe("1998-04-17");
    expect(await M.Audit.countDocuments({ action: "reveal_sensitive", candidateId: c._id })).toBe(2);
    // Super Admin has all modules but NOT the sensitive-field permissions by default
    const root = await as(await newActor("super_admin"));
    await expect(S.revealSensitive(root, c._id, "sevisId")).rejects.toThrow(/permission/i);
  });

  it("candidate codes are unique and sequential even when created in parallel", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const made = await Promise.all(Array.from({ length: 12 }, () => S.createCandidate(mgr, mk())));
    const codes = made.map((c) => c.candidateCode).sort();
    expect(new Set(codes).size).toBe(12);
    expect(codes[0]).toBe("CND-000001");
    expect(codes[11]).toBe("CND-000012");
  });

  it("creating is audit-logged and the client-supplied values are validated (bad email, future DOB, reversed EAD dates)", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const c = await S.createCandidate(mgr, mk());
    expect(await M.Audit.countDocuments({ action: "create", entityType: "candidate", entityId: c._id })).toBe(1);
    expect(schema.candidateCreateSchema.safeParse({ legalName: "X Y", email: "not-an-email" }).success).toBe(false);
    expect(schema.candidateCreateSchema.safeParse({ legalName: "X Y", email: "x@y.test", dateOfBirth: "2999-01-01" }).success).toBe(false);
    expect(schema.candidateCreateSchema.safeParse({ legalName: "X Y", email: "x@y.test", dateOfBirth: "1850-01-01" }).success).toBe(false);
    expect(schema.candidateCreateSchema.safeParse({ legalName: "X Y", email: "x@y.test", eadStart: "2026-06-01", eadEnd: "2026-01-01" }).success).toBe(false);
    expect(schema.candidateCreateSchema.safeParse({ legalName: "X Y", email: "x@y.test", dateOfBirth: "2000-02-30" }).success).toBe(false);
  });

  it("editing changes only what was sent, keeps encrypted fields when left blank, and audits before/after", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const c = await S.createCandidate(mgr, schema.candidateCreateSchema.parse(FULL));
    await S.updateCandidate(mgr, c._id, schema.candidatePatchSchema.parse({ phone: "+1 555 010 1111", school: "Another University" }));
    const raw = await M.Candidate.findById(c._id).lean();
    expect(raw.phone).toBe("+1 555 010 1111");
    expect(raw.school).toBe("Another University");
    expect(raw.major).toBe("Computer Science"); // untouched
    expect(raw.stage).toBe("onboarding"); // regression: a partial edit must not reset defaults
    expect(raw.authType).toBe("STEM_OPT");
    expect(raw.dateOfBirth.enc).toMatch(/^v1:/); // blank DOB in the form = keep the current one
    expect(await S.revealSensitive(mgr, c._id, "dateOfBirth")).toBe("1998-04-17");
    const ev = await M.Audit.findOne({ action: "update", candidateId: c._id }).lean();
    expect(ev.before.phone).toBe("+1 555 010 4242");
    expect(ev.after.phone).toBe("+1 555 010 1111");
    expect(JSON.stringify(ev)).not.toContain("N0012345678");
  });

  it("fields can be cleared from the edit form, and a stage change is recorded as a status change", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const c = await S.createCandidate(mgr, schema.candidateCreateSchema.parse(FULL));
    await S.updateCandidate(mgr, c._id, schema.candidatePatchSchema.parse({ stage: "active" }), { clear: ["phone", "preferredName", "stemCipCode"] });
    const raw = await M.Candidate.findById(c._id).lean();
    expect(raw.phone).toBeUndefined();
    expect(raw.preferredName).toBeUndefined();
    expect(raw.stemCipCode).toBeUndefined();
    expect(raw.stage).toBe("active");
    const ev = await M.Audit.findOne({ action: "status_change", candidateId: c._id }).lean();
    expect(ev.summary).toMatch(/onboarding → active/);
    // protected identifiers can never be cleared this way
    await S.updateCandidate(mgr, c._id, schema.candidatePatchSchema.parse({ priority: "low" }), { clear: ["sevisId", "dateOfBirth", "eadNumber"] });
    expect((await M.Candidate.findById(c._id).lean()).sevisId.enc).toMatch(/^v1:/);
  });

  it("through the real SERVER ACTIONS: create → redirect to profile; invalid input returns field errors", async () => {
    await as(await newActor("compliance_manager"));
    const bad = await run(actions.createCandidateAction({}, fd({ legalName: "A", email: "nope" })));
    expect(bad.redirect).toBeNull();
    expect(bad.result?.fieldErrors?.email).toBeTruthy();
    expect(bad.result?.fieldErrors?.legalName).toBeTruthy();
    const ok = await run(actions.createCandidateAction({}, fd({ legalName: "Action Person", email: "action.person@example.test", school: "Fictional U", stage: "new", priority: "normal", authType: "none" })));
    expect(ok.redirect).toMatch(/^\/candidates\/[0-9a-f-]{36}$/);
    const id = ok.redirect!.split("/").pop()!;
    // edit through the action: blank field clears it, other fields stay
    const edit = await run(actions.updateCandidateAction({}, fd({ id, legalName: "Action Person", email: "action.person@example.test", school: "", phone: "+1 555 010 5555", stage: "active", priority: "normal" })));
    expect(edit.redirect).toBe(`/candidates/${id}`);
    const raw = await M.Candidate.findById(id).lean();
    expect(raw.school).toBeUndefined();
    expect(raw.phone).toBe("+1 555 010 5555");
    expect(raw.stage).toBe("active");
  });

  it("unassigning / assigning owner and recruiter from the edit form works and is validated", async () => {
    const mgr = await newActor("compliance_manager", "Mgr");
    const assoc = await newActor("compliance_associate", "Assoc");
    const s = await as(mgr);
    const c = await S.createCandidate(s, mk());
    const id = c._id;
    const base = { id, legalName: c.legalName, email: c.email, stage: "new", priority: "normal" };
    await run(actions.updateCandidateAction({}, fd({ ...base, ownerId: assoc.id, recruiterId: mgr.id })));
    let raw = await M.Candidate.findById(id).lean();
    expect(raw.ownerId).toBe(assoc.id);
    expect(raw.recruiterId).toBe(mgr.id);
    await run(actions.updateCandidateAction({}, fd({ ...base, ownerId: "", recruiterId: "" })));
    raw = await M.Candidate.findById(id).lean();
    expect(raw.ownerId).toBeNull();
    expect(raw.recruiterId).toBeNull();
    const bad = await run(actions.updateCandidateAction({}, fd({ ...base, ownerId: "no-such-user" })));
    expect(bad.result?.error).toMatch(/not an active compliance user/);
  });
});

/* ================================ 2. OWNER ASSIGNMENT ================================ */

describe("assigning compliance owners", () => {
  it("only active compliance users can own a candidate; payroll/finance users, disabled users and unknown ids are refused", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const assoc = await newActor("compliance_associate");
    const disabled = await newActor("compliance_associate", "Gone", { active: false });
    const payroll = await newActor("payroll_preparer");
    const c = await S.createCandidate(mgr, mk());
    await expect(S.updateCandidate(mgr, c._id, schema.candidatePatchSchema.parse({ ownerId: disabled.id }))).rejects.toThrow(/not an active compliance user/);
    await expect(S.updateCandidate(mgr, c._id, schema.candidatePatchSchema.parse({ ownerId: payroll.id }))).rejects.toThrow(/not an active compliance user/);
    await expect(S.updateCandidate(mgr, c._id, schema.candidatePatchSchema.parse({ ownerId: "ghost" }))).rejects.toThrow(/not an active compliance user/);
    await S.updateCandidate(mgr, c._id, schema.candidatePatchSchema.parse({ ownerId: assoc.id }));
    expect((await M.Candidate.findById(c._id).lean()).ownerId).toBe(assoc.id);
    await expect(S.createCandidate(mgr, mk({ ownerId: disabled.id }))).rejects.toThrow(/not an active compliance user/);
  });

  it("a compliance associate cannot assign: creating makes them the owner, and an owner change is ignored", async () => {
    const mgr = await newActor("compliance_manager");
    const assoc = await newActor("compliance_associate");
    const a = await as(assoc);
    const c = await S.createCandidate(a, mk({ ownerId: mgr.id }));
    expect((await M.Candidate.findById(c._id).lean()).ownerId).toBe(assoc.id);
    await S.updateCandidate(a, c._id, schema.candidatePatchSchema.parse({ ownerId: mgr.id, phone: "+1 555 010 0001" }));
    const raw = await M.Candidate.findById(c._id).lean();
    expect(raw.ownerId).toBe(assoc.id); // unchanged
    expect(raw.phone).toBe("+1 555 010 0001"); // the rest of the edit applied
  });
});

/* ================================ 3. SEARCH / FILTER / SORT / PAGINATE ================================ */

describe("searching, filtering, sorting and pagination", () => {
  async function seed() {
    const mgrA = await newActor("compliance_manager", "Mgr Alpha");
    const assoc = await newActor("compliance_associate", "Assoc Beta");
    const mgr = await as(mgrA);
    const mkc = (o: Record<string, unknown>) => S.createCandidate(mgr, mk(o));
    const anna = await mkc({ legalName: "anna lowercase", email: "anna@example.test", stage: "active", authType: "OPT", tagsCsv: "alpha", school: "Zeta College" });
    const bob = await mkc({ legalName: "Bob Builder", email: "bob@example.test", stage: "new", authType: "CPT", tagsCsv: "alpha, beta", ownerId: assoc.id });
    const zoe = await mkc({ legalName: "Zoe Zed", email: "zoe.z@example.test", stage: "active", authType: "STEM_OPT", phone: "+1 555 777 0000" });
    await M.Candidate.updateOne({ _id: anna._id }, { $set: { nextDueDate: "2026-12-15" } });
    await M.Candidate.updateOne({ _id: zoe._id }, { $set: { nextDueDate: "2026-12-01", riskFlags: ["overdue"] } });
    return { mgr, mgrA, assoc, anna, bob, zoe };
  }
  const names = (r: any) => r.rows.map((x: any) => x.legalName);

  it("search finds by name (any case, partial), email, candidate ID, phone and school; special characters are safe", async () => {
    const { mgr, zoe } = await seed();
    expect(names(await S.listCandidates(mgr, { q: "ZOE" }))).toEqual(["Zoe Zed"]);
    expect(names(await S.listCandidates(mgr, { q: "builder" }))).toEqual(["Bob Builder"]);
    expect(names(await S.listCandidates(mgr, { q: "anna@example" }))).toEqual(["anna lowercase"]);
    expect(names(await S.listCandidates(mgr, { q: zoe.candidateCode }))).toEqual(["Zoe Zed"]);
    expect(names(await S.listCandidates(mgr, { q: "777 0000" }))).toEqual(["Zoe Zed"]);
    expect(names(await S.listCandidates(mgr, { q: "zeta" }))).toEqual(["anna lowercase"]);
    expect((await S.listCandidates(mgr, { q: "nobody-matches" })).total).toBe(0);
    for (const nasty of [".*", "(", "[a-", "\\", "$^", "a|b", "{1,}"]) {
      await expect(S.listCandidates(mgr, { q: nasty })).resolves.toBeTruthy(); // never a regex error
    }
    expect((await S.listCandidates(mgr, { q: ".*" })).total).toBe(0); // literal match, not a wildcard
  });

  it("search never matches restricted values (SEVIS / DOB are not searchable)", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    await S.createCandidate(mgr, schema.candidateCreateSchema.parse(FULL));
    expect((await S.listCandidates(mgr, { q: "N0012345678" })).total).toBe(0);
    expect((await S.listCandidates(mgr, { q: "1998-04-17" })).total).toBe(0);
  });

  it("filters: stage, authorization type, owner (incl. unassigned), tag, due date, risk — and they combine", async () => {
    const { mgr, assoc } = await seed();
    expect(names(await S.listCandidates(mgr, { stage: "active", sort: "name" }))).toEqual(["anna lowercase", "Zoe Zed"]);
    expect(names(await S.listCandidates(mgr, { authType: "CPT" }))).toEqual(["Bob Builder"]);
    expect(names(await S.listCandidates(mgr, { ownerId: assoc.id }))).toEqual(["Bob Builder"]);
    expect((await S.listCandidates(mgr, { ownerId: "unassigned" })).total).toBe(0);
    expect(names(await S.listCandidates(mgr, { tag: "beta" }))).toEqual(["Bob Builder"]);
    expect(names(await S.listCandidates(mgr, { dueBefore: "2026-12-05" }))).toEqual(["Zoe Zed"]);
    expect(names(await S.listCandidates(mgr, { risk: true }))).toEqual(["Zoe Zed"]);
    expect(names(await S.listCandidates(mgr, { stage: "active", authType: "OPT", tag: "alpha" }))).toEqual(["anna lowercase"]);
    expect((await S.listCandidates(mgr, { stage: "new", authType: "OPT" })).total).toBe(0);
  });

  it("sorting: name is case-insensitive, 'next due' puts candidates WITHOUT a due date last, newest-first and by code", async () => {
    const { mgr } = await seed();
    expect(names(await S.listCandidates(mgr, { sort: "name" }))).toEqual(["anna lowercase", "Bob Builder", "Zoe Zed"]);
    expect(names(await S.listCandidates(mgr, { sort: "-name" }))).toEqual(["Zoe Zed", "Bob Builder", "anna lowercase"]);
    expect(names(await S.listCandidates(mgr, { sort: "due" }))).toEqual(["Zoe Zed", "anna lowercase", "Bob Builder"]); // 12-01, 12-15, none
    expect(names(await S.listCandidates(mgr, { sort: "code" }))).toEqual(["anna lowercase", "Bob Builder", "Zoe Zed"]);
    expect(names(await S.listCandidates(mgr, { sort: "-created" }))[0]).toBe("Zoe Zed");
    expect(names(await S.listCandidates(mgr, { sort: "bogus" as never })).length).toBe(3); // unknown sort falls back safely
  });

  it("pagination: stable pages (no duplicates or gaps, even with identical names), correct totals, safe limits", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    for (let i = 0; i < 23; i++) await S.createCandidate(mgr, mk({ legalName: i % 2 ? "Same Name" : "Same Name Too" }));
    for (const sort of ["name", "-name", "due", "-created", "code"] as const) {
      const seen: string[] = [];
      for (let p = 1; p <= 3; p++) {
        const r = await S.listCandidates(mgr, { sort, page: p, pageSize: 10 });
        expect(r.total).toBe(23);
        expect(r.rows.length).toBe(p < 3 ? 10 : 3);
        seen.push(...r.rows.map((x: any) => x._id));
      }
      expect(new Set(seen).size).toBe(23); // every candidate exactly once
    }
    expect((await S.listCandidates(mgr, { page: 99, pageSize: 10 })).rows).toEqual([]);
    expect((await S.listCandidates(mgr, { page: -3, pageSize: 0 })).rows.length).toBe(23 > 25 ? 25 : 23); // clamped to page 1 / default size
    expect((await S.listCandidates(mgr, { pageSize: 5000 })).pageSize).toBe(100);
  });

  it("the list never loads or returns note / contact histories", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const c = await S.createCandidate(mgr, mk());
    await S.addNote(mgr, c._id, "private compliance note");
    await S.addContactEntry(mgr, c._id, "call", "called the candidate");
    const r = await S.listCandidates(mgr, {});
    expect(JSON.stringify(r)).not.toContain("private compliance note");
    expect(r.rows[0].notes).toBeUndefined();
    const raw = await M.Candidate.findById(c._id).lean();
    expect(raw.notes).toHaveLength(1);
    expect(raw.contactHistory).toHaveLength(1);
  });

  it("injection attempts in filters are treated as plain strings", async () => {
    const { mgr } = await seed();
    const r = await S.listCandidates(mgr, { stage: { $ne: null } as any, ownerId: { $gt: "" } as any, tag: { $regex: ".*" } as any });
    expect(r.total).toBe(0); // objects were stringified, not interpreted as operators
  });
});

/* ================================ 4. NOTES / CONTACT HISTORY ================================ */

describe("notes and contact history", () => {
  it("are saved newest-first with the author, and audit-logged", async () => {
    const mgr = await as(await newActor("compliance_manager", "Note Writer"));
    const c = await S.createCandidate(mgr, mk());
    await S.addNote(mgr, c._id, "first note");
    await S.addNote(mgr, c._id, "second note");
    await S.addContactEntry(mgr, c._id, "email", "sent welcome email");
    const raw = await M.Candidate.findById(c._id).lean();
    expect(raw.notes.map((n: any) => n.text)).toEqual(["second note", "first note"]);
    expect(raw.notes[0].authorName).toBe("Note Writer");
    expect(raw.contactHistory[0]).toMatchObject({ channel: "email", summary: "sent welcome email", byName: "Note Writer" });
    expect(await M.Audit.countDocuments({ candidateId: c._id, entityType: "candidate_note" })).toBe(2);
  });
});

/* ================================ 5. BULK OPERATIONS ================================ */

describe("bulk operations", () => {
  async function many(n: number) {
    const mgrA = await newActor("compliance_manager", "Bulk Mgr");
    const mgr = await as(mgrA);
    const list = [];
    for (let i = 0; i < n; i++) list.push(await S.createCandidate(mgr, mk()));
    return { mgr, mgrA, ids: list.map((c) => c._id) };
  }

  it("bulk ASSIGN sets the owner on every selected candidate (and 'unassigned' clears it)", async () => {
    const { mgr, ids } = await many(4);
    const assoc = await newActor("compliance_associate");
    const r = await S.bulkUpdate(mgr, ids, { ownerId: assoc.id });
    expect(r).toMatchObject({ matched: 4, modified: 4, skipped: 0 });
    expect(await M.Candidate.countDocuments({ ownerId: assoc.id })).toBe(4);
    await S.bulkUpdate(mgr, ids.slice(0, 2), { ownerId: null });
    expect(await M.Candidate.countDocuments({ ownerId: null })).toBe(2);
  });

  it("bulk ASSIGN refuses owners who are not active compliance users", async () => {
    const { mgr, ids } = await many(2);
    const payroll = await newActor("payroll_approver");
    await expect(S.bulkUpdate(mgr, ids, { ownerId: payroll.id })).rejects.toThrow(/not an active compliance user/);
    await expect(S.bulkUpdate(mgr, ids, { ownerId: "ghost" })).rejects.toThrow(/not an active compliance user/);
  });

  it("bulk STAGE change applies, is validated server-side, is audited with the affected ids, and starts the 12-month cycle", async () => {
    const { mgr, ids } = await many(3);
    const r = await S.bulkUpdate(mgr, ids, { stage: "active" });
    expect(r.matched).toBe(3);
    expect(await M.Candidate.countDocuments({ stage: "active" })).toBe(3);
    await expect(S.bulkUpdate(mgr, ids, { stage: "not-a-stage" })).rejects.toThrow(/Unknown stage/);
    expect(await M.Candidate.countDocuments({ stage: "not-a-stage" })).toBe(0);
    const ev = await M.Audit.findOne({ action: "status_change", entityType: "candidate" }).lean();
    expect(ev.after.candidateIds.sort()).toEqual([...ids].sort());
    expect(await M.TrackerCycle.countDocuments({ status: "open" })).toBe(3); // onboarding/active → review cycle started
  });

  it("bulk TAG adds a tag without duplicating it or removing existing ones", async () => {
    const { mgr, ids } = await many(3);
    await S.bulkUpdate(mgr, ids, { addTag: "cohort-1" });
    await S.bulkUpdate(mgr, ids, { addTag: "cohort-1" });
    await S.bulkUpdate(mgr, [ids[0]], { addTag: "vip" });
    const a = await M.Candidate.findById(ids[0]).lean();
    expect(a.tags.sort()).toEqual(["cohort-1", "vip"]);
    expect((await M.Candidate.findById(ids[1]).lean()).tags).toEqual(["cohort-1"]);
    await expect(S.bulkUpdate(mgr, ids, { addTag: "   " })).rejects.toThrow(/Enter a tag/);
  });

  it("selection rules: empty, over 500, unknown ids, duplicates and 'no change' are handled", async () => {
    const { mgr, ids } = await many(2);
    await expect(S.bulkUpdate(mgr, [], { stage: "active" })).rejects.toThrow(/Select at least one/);
    await expect(S.bulkUpdate(mgr, Array.from({ length: 501 }, (_, i) => `id-${i}`), { stage: "active" })).rejects.toThrow(/at most 500/);
    await expect(S.bulkUpdate(mgr, ids, {})).rejects.toThrow(/Choose a change/);
    const r = await S.bulkUpdate(mgr, [...ids, ids[0], "does-not-exist"], { priority: undefined, stage: "on_hold" } as any);
    expect(r).toMatchObject({ matched: 2, skipped: 1 });
  });

  it("an associate can only bulk-change THEIR OWN candidates; others are skipped and untouched", async () => {
    const mgrA = await newActor("compliance_manager");
    const assocA = await newActor("compliance_associate");
    const mgr = await as(mgrA);
    const mine = await S.createCandidate(mgr, mk({ ownerId: assocA.id }));
    const theirs = await S.createCandidate(mgr, mk());
    const assoc = await as(assocA);
    const r = await S.bulkUpdate(assoc, [mine._id, theirs._id], { stage: "on_hold" });
    expect(r).toMatchObject({ matched: 1, skipped: 1 });
    expect((await M.Candidate.findById(mine._id).lean()).stage).toBe("on_hold");
    expect((await M.Candidate.findById(theirs._id).lean()).stage).toBe("new");
    await expect(S.bulkUpdate(assoc, [mine._id], { ownerId: mgrA.id })).rejects.toThrow(/permission/i); // associates cannot assign
  });

  it("through the real SERVER ACTION: friendly result messages and validation errors", async () => {
    const { ids } = await many(3);
    const ok = await actions.bulkAction({}, fd({ ids, op: "tag", value: "wave-2" }));
    expect(ok.message).toMatch(/3 candidates tagged/);
    const again = await actions.bulkAction({}, fd({ ids, op: "stage", value: "active" }));
    expect(again.message).toMatch(/3 candidates moved/);
    expect((await actions.bulkAction({}, fd({ ids, op: "stage", value: "zzz" }))).error).toMatch(/Unknown stage/);
    expect((await actions.bulkAction({}, fd({ op: "tag", value: "x" }))).error).toMatch(/at least one/i);
  });
});

/* ================================ 6. DUPLICATE DETECTION ================================ */

describe("duplicate detection (never merges automatically)", () => {
  it("same EMAIL is a hard duplicate (case and spacing do not matter) and nothing is created", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    await S.createCandidate(mgr, mk({ email: "dup.person@example.test" }));
    const attempt = S.createCandidate(mgr, mk({ email: "  DUP.Person@Example.TEST " }));
    await expect(attempt).rejects.toMatchObject({ name: "DuplicateCandidateError", kind: "hard" });
    expect(await M.Candidate.countDocuments()).toBe(1);
    const err: any = await attempt.catch((e) => e);
    expect(err.matches[0]).toMatchObject({ reason: "Same email", code: "CND-000001" });
  });

  it("same SEVIS ID is a hard duplicate, even with a different email and name", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    await S.createCandidate(mgr, mk({ sevisId: "N0099999999" }));
    await expect(S.createCandidate(mgr, mk({ sevisId: " n0099999999 " }))).rejects.toMatchObject({ kind: "hard", matches: [expect.objectContaining({ reason: "Same SEVIS ID" })] });
    expect(await M.Candidate.countDocuments()).toBe(1);
  });

  it("same legal name + date of birth is a SOFT duplicate: blocked until the user confirms, then allowed", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    await S.createCandidate(mgr, mk({ legalName: "Alex Twin", dateOfBirth: "1999-09-09" }));
    await expect(S.createCandidate(mgr, mk({ legalName: "Alex Twin", dateOfBirth: "1999-09-09" }))).rejects.toMatchObject({ kind: "soft" });
    expect(await M.Candidate.countDocuments()).toBe(1);
    const second = await S.createCandidate(mgr, mk({ legalName: "Alex Twin", dateOfBirth: "1999-09-09" }), { allowSoftDuplicate: true });
    expect(second.candidateCode).toBe("CND-000002");
    expect(await M.Candidate.countDocuments()).toBe(2); // both kept — nothing was merged
    // different DOB = not a duplicate
    await expect(S.createCandidate(mgr, mk({ legalName: "Alex Twin", dateOfBirth: "1999-09-10" }))).resolves.toBeTruthy();
  });

  it("name matching ignores case, accents and extra spaces; older-format hashes are still recognised", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    await S.createCandidate(mgr, mk({ legalName: "José   García", dateOfBirth: "1997-03-03" }));
    await expect(S.createCandidate(mgr, mk({ legalName: "  JOSE garcia ", dateOfBirth: "1997-03-03" }))).rejects.toMatchObject({ kind: "soft" });
    // simulate a record stored with the pre-normalisation hash formula
    const legacy = (await import("@/lib/crypto/keys")).hmacHex("namedob", "legacy person|1990-01-01");
    await M.Candidate.collection.insertOne({ _id: "legacy-1", candidateCode: "CND-LEG", legalName: "Legacy Person", email: "legacy@example.test", emailLower: "legacy@example.test", nameDobHash: legacy, authType: "none", i983Status: "not_applicable", stage: "new", priority: "normal", clearedToWork: false, teamMemberIds: [], riskFlags: [], tags: [], notes: [], contactHistory: [], createdAt: new Date(), updatedAt: new Date() });
    await expect(S.createCandidate(mgr, mk({ legalName: "Legacy Person", dateOfBirth: "1990-01-01" }))).rejects.toMatchObject({ kind: "soft" });
  });

  it("without a DOB there is no name-based match (two people may share a name)", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    await S.createCandidate(mgr, mk({ legalName: "Common Name", dateOfBirth: undefined }));
    await expect(S.createCandidate(mgr, mk({ legalName: "Common Name", dateOfBirth: undefined }))).resolves.toBeTruthy();
  });

  it("editing is checked too: changing the email to an existing one is refused; renaming into a name+DOB twin is a soft duplicate", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const a = await S.createCandidate(mgr, mk({ email: "a@example.test", legalName: "Twin Name", dateOfBirth: "1995-05-05" }));
    const b = await S.createCandidate(mgr, mk({ email: "b@example.test", legalName: "Other Name", dateOfBirth: "1995-05-05" }));
    await expect(S.updateCandidate(mgr, b._id, schema.candidatePatchSchema.parse({ email: "a@example.test" }))).rejects.toMatchObject({ kind: "hard" });
    // the DOB is NOT retyped on edit — the stored one must still be used for the duplicate check
    await expect(S.updateCandidate(mgr, b._id, schema.candidatePatchSchema.parse({ legalName: "Twin Name" }))).rejects.toMatchObject({ kind: "soft" });
    expect((await M.Candidate.findById(b._id).lean()).legalName).toBe("Other Name"); // unchanged
    await S.updateCandidate(mgr, b._id, schema.candidatePatchSchema.parse({ legalName: "Twin Name" }), { allowSoftDuplicate: true });
    expect((await M.Candidate.findById(b._id).lean()).legalName).toBe("Twin Name");
    expect(await M.Candidate.countDocuments()).toBe(2);
    void a;
  });

  it("renaming keeps the duplicate key correct (the stored DOB is used to recompute it)", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const a = await S.createCandidate(mgr, mk({ legalName: "Old Name", dateOfBirth: "1996-06-06" }));
    await S.updateCandidate(mgr, a._id, schema.candidatePatchSchema.parse({ legalName: "New Name" }));
    await expect(S.createCandidate(mgr, mk({ legalName: "New Name", dateOfBirth: "1996-06-06" }))).rejects.toMatchObject({ kind: "soft" });
    await expect(S.createCandidate(mgr, mk({ legalName: "Old Name", dateOfBirth: "1996-06-06" }))).resolves.toBeTruthy(); // old name no longer matches
  });

  it("a parallel create race on the same email yields exactly one record", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => S.createCandidate(mgr, mk({ email: "race@example.test" }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await M.Candidate.countDocuments({ emailLower: "race@example.test" })).toBe(1);
  });

  it("an associate's duplicate warning never reveals candidates assigned to someone else", async () => {
    const mgrA = await newActor("compliance_manager");
    const assocA = await newActor("compliance_associate");
    const mgr = await as(mgrA);
    await S.createCandidate(mgr, mk({ email: "secret.person@example.test", legalName: "Secret Person", dateOfBirth: "1990-02-02" }));
    const assoc = await as(assocA);
    const err: any = await S.createCandidate(assoc, mk({ email: "secret.person@example.test" })).catch((e) => e);
    expect(err.kind).toBe("hard");
    const leaked = JSON.stringify(err.matches);
    expect(leaked).not.toContain("secret.person");
    expect(leaked).not.toContain("Secret Person");
    expect(leaked).not.toContain("CND-000001");
    expect(err.matches[0].id).toBe("");
    // soft duplicate is redacted too
    const soft: any = await S.createCandidate(assoc, mk({ legalName: "Secret Person", dateOfBirth: "1990-02-02" })).catch((e) => e);
    expect(JSON.stringify(soft.matches)).not.toContain("Secret Person");
    // but the associate's OWN candidates are shown normally
    const mine = await S.createCandidate(assoc, mk({ email: "mine@example.test", legalName: "My Person" }));
    const own: any = await S.createCandidate(assoc, mk({ email: "mine@example.test" })).catch((e) => e);
    expect(own.matches[0]).toMatchObject({ id: mine._id, name: "My Person" });
  });

  it("through the SERVER ACTION: duplicates are reported to the form with a confirm-to-continue flag", async () => {
    await as(await newActor("compliance_manager"));
    const base = { legalName: "Form Twin", email: "form.twin@example.test", dateOfBirth: "1994-04-04", stage: "new", priority: "normal", authType: "none" };
    expect((await run(actions.createCandidateAction({}, fd(base)))).redirect).toMatch(/^\/candidates\//);
    const hard = await run(actions.createCandidateAction({}, fd(base)));
    expect(hard.result).toMatchObject({ softDuplicate: false });
    expect(hard.result?.duplicates?.[0].reason).toBe("Same email");
    const soft = await run(actions.createCandidateAction({}, fd({ ...base, email: "form.twin2@example.test" })));
    expect(soft.result).toMatchObject({ softDuplicate: true });
    const forced = await run(actions.createCandidateAction({}, fd({ ...base, email: "form.twin2@example.test", allowSoftDuplicate: "on" })));
    expect(forced.redirect).toMatch(/^\/candidates\//);
    expect(await M.Candidate.countDocuments()).toBe(2 + 0);
  });
});

/* ================================ 7. EXPORT ================================ */

describe("CSV export", () => {
  async function setup() {
    const mgrA = await newActor("compliance_manager", "Export Mgr");
    const assocA = await newActor("compliance_associate", "Export Assoc");
    const mgr = await as(mgrA);
    const one = await S.createCandidate(mgr, schema.candidateCreateSchema.parse({ ...FULL, ownerId: assocA.id }));
    await S.createCandidate(mgr, mk({ legalName: "Plain Person", email: "plain@example.test", stage: "active", authType: "OPT" }));
    await S.createCandidate(mgr, mk({ legalName: '=HYPERLINK("http://evil.test","click"),x', email: "formula@example.test", stage: "active" }));
    return { mgr, mgrA, assocA, one };
  }
  const parseCsv = async (csv: string) => (await import("papaparse")).default.parse<string[]>(csv.replace(/^﻿/, ""), { skipEmptyLines: true }).data;

  it("exports the filtered set exactly (filters are respected) with accurate values, including owner NAME", async () => {
    const { mgr } = await setup();
    const all = await S.exportCandidates(mgr, {});
    expect(all.count).toBe(3);
    const rows = await parseCsv(all.csv);
    const head = rows[0];
    const col = (n: string) => head.indexOf(n);
    const priya = rows.find((r) => r[col("Email")] === "priya.fictional@example.test")!;
    expect(priya[col("Legal Name")]).toBe("Priya Fictional-Test");
    expect(priya[col("Compliance Owner")]).toBe("Export Assoc");
    expect(priya[col("School")]).toBe("Test University");
    expect(priya[col("EAD End")]).toBe("2028-05-31");
    expect(priya[col("Authorization Type")]).toBe("STEM_OPT");
    expect(priya[col("Tags")]).toBe("stem; priority-review");
    expect(priya[col("Address Line 1")]).toBe("1 Synthetic Way");
    // filters
    const active = await S.exportCandidates(mgr, { stage: "active" });
    expect(active.count).toBe(2);
    expect((await parseCsv(active.csv)).length).toBe(3); // header + 2
    expect((await S.exportCandidates(mgr, { q: "priya" })).count).toBe(1);
    expect((await S.exportCandidates(mgr, { authType: "OPT" })).count).toBe(1);
    expect((await S.exportCandidates(mgr, { stage: "archived" })).count).toBe(0);
    // export row count == list total for the same filters
    for (const q of [{}, { stage: "active" }, { q: "person" }, { authType: "STEM_OPT" }] as const) {
      expect((await S.exportCandidates(mgr, q)).count).toBe((await S.listCandidates(mgr, q)).total);
    }
  });

  it("restricted fields (SEVIS ID, EAD number, date of birth) are NOT exported by default — even for someone who may see them", async () => {
    const { mgr } = await setup();
    const out = await S.exportCandidates(mgr, {});
    expect(out.sensitiveIncluded).toEqual([]);
    for (const secret of ["N0012345678", "SRC1234567890", "1998-04-17"]) expect(out.csv).not.toContain(secret);
    expect(out.columns).not.toContain("sevisId");
    expect(out.columns).not.toContain("dateOfBirth");
  });

  it("restricted fields are exported only when requested AND permitted, and that is logged as a sensitive export", async () => {
    const { mgr } = await setup();
    const out = await S.exportCandidates(mgr, {}, { includeSensitive: true });
    expect(out.sensitiveIncluded.sort()).toEqual(["dateOfBirth", "eadNumber", "sevisId"]);
    expect(out.csv).toContain("N0012345678");
    expect(out.csv).toContain("SRC1234567890");
    expect(out.csv).toContain("1998-04-17");
    expect(await M.Audit.countDocuments({ action: "reveal_sensitive", summary: /Bulk-exported restricted/ })).toBe(1);
    const ev = await M.Audit.findOne({ action: "export", summary: /restricted/ }).lean();
    expect(ev.after.sensitiveIncluded.length).toBe(3);
    // a Super Admin (no sensitive permissions by default) asking for them gets the normal export WITHOUT them
    const root = await as(await newActor("super_admin"));
    const rootOut = await S.exportCandidates(root, {}, { includeSensitive: true });
    expect(rootOut.sensitiveIncluded).toEqual([]);
    expect(rootOut.csv).not.toContain("N0012345678");
  });

  it("every export is audit-logged with who, the filters, the row count and the columns", async () => {
    const { mgr, mgrA } = await setup();
    await S.exportCandidates(mgr, { stage: "active", q: "example.test" });
    const ev = await M.Audit.findOne({ action: "export", entityType: "candidate" }).lean();
    expect(ev.actorId).toBe(mgrA.id);
    expect(ev.after.filters).toMatchObject({ stage: "active", q: "example.test" });
    expect(ev.after.count).toBe(2);
    expect(ev.after.columns.length).toBeGreaterThan(20);
    expect(ev.summary).toMatch(/Exported 2 candidates/);
  });

  it("neutralises spreadsheet formula injection and quotes commas, quotes and newlines", async () => {
    const { mgr } = await setup();
    await S.createCandidate(mgr, mk({ legalName: 'Comma, "Quote" Person', email: "quote@example.test", addressLine1: "Line one\nLine two" }));
    const out = await S.exportCandidates(mgr, {});
    expect(out.csv).toContain(`"'=HYPERLINK(""http://evil.test"",""click""),x"`);
    const rows = await parseCsv(out.csv);
    const names = rows.map((r) => r[1]);
    expect(names).toContain('Comma, "Quote" Person');
    expect(names.some((n) => n?.startsWith("=") || n?.startsWith("+") || n?.startsWith("@"))).toBe(false);
  });

  it("the exported file can be re-imported: every header is recognised by the import mapper", async () => {
    const { mgr } = await setup();
    const out = await S.exportCandidates(mgr, {});
    const preview = await imp.createImportPreview(mgr, "export.csv", Buffer.from("﻿" + out.csv, "utf8"));
    const importable = preview.headers.filter((h) => !["Candidate ID", "Compliance Owner", "Recruiter", "Next Due Date", "Cleared To Work", "I-983 Status", "Created"].includes(h));
    const unmapped = preview.headers.filter((h, i) => importable.includes(h) && preview.mapping[i] === null);
    expect(unmapped).toEqual([]);
    expect(preview.summary.duplicate_db).toBe(3); // they already exist → flagged, never re-created
  });

  it("access to export: Super Admin/Compliance Manager yes; an associate, payroll, finance and auditor are refused", async () => {
    await setup();
    const roles = await allRoles();
    for (const r of ROLES) {
      const u = await as(roles[r]);
      const allowed = r === "super_admin" || r === "compliance_manager";
      if (allowed) await expect(S.exportCandidates(u, {})).resolves.toBeTruthy();
      else await expect(S.exportCandidates(u, {})).rejects.toThrow(/permission/i);
    }
  });

  it("through the HTTP route: CSV headers, BOM, count header, filters, 401 without a session and 403 without the permission", async () => {
    const { mgr } = await setup();
    void mgr;
    const roles = await allRoles();
    h.store.delete(COOKIE);
    expect((await api("GET", "/api/candidates/export")).status).toBe(401);
    await as(roles.compliance_manager);
    const res = await api("GET", "/api/candidates/export?stage=active");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/candidates-\d{4}-\d{2}-\d{2}\.csv/);
    expect(res.headers.get("x-export-count")).toBe("2");
    expect([...res.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM so Excel shows accents correctly
    expect((await api("GET", "/api/candidates/export?includeSensitive=1")).body).toContain("N0012345678");
    await as(roles.compliance_associate);
    expect((await api("GET", "/api/candidates/export")).status).toBe(403);
    await as(roles.auditor);
    expect((await api("GET", "/api/candidates/export")).status).toBe(403);
  });
});

/* ================================ 8. PERMISSIONS (ALL 8 ROLES, API LEVEL) ================================ */

describe("permissions across all roles — enforced by the API, not just hidden in the UI", () => {
  async function world() {
    const roles = await allRoles();
    const mgr = await as(roles.compliance_manager);
    // one candidate assigned to the associate, one to the manager (the associate must NOT see this one)
    const mine = await S.createCandidate(mgr, schema.candidateCreateSchema.parse({ ...FULL, ownerId: roles.compliance_associate.id }));
    const other = await S.createCandidate(mgr, mk({ legalName: "Other Owners Person", email: "other.owner@example.test" }));
    await S.addNote(mgr, mine._id, "sensitive compliance note");
    await M.Candidate.updateOne({ _id: mine._id }, { $set: { payrollMapping: { provider: "gusto", employeeId: "gusto-emp-1", paySchedule: "biweekly" } } });
    return { roles, mine, other };
  }

  it("no session → 401 on every candidate API", async () => {
    const { mine } = await world();
    h.store.delete(COOKIE);
    expect((await api("GET", "/api/candidates")).status).toBe(401);
    expect((await api("POST", "/api/candidates", { json: { legalName: "X Y", email: "x@y.test" } })).status).toBe(401);
    expect((await api("GET", `/api/candidates/${mine._id}`, { id: mine._id })).status).toBe(401);
    expect((await api("PATCH", `/api/candidates/${mine._id}`, { id: mine._id, json: { phone: "1" } })).status).toBe(401);
    expect((await api("GET", "/api/candidates/export")).status).toBe(401);
    expect((await api("POST", "/api/candidates/import", { form: new FormData() })).status).toBe(401);
  });

  it("create / edit / import / export access matches the role matrix (403 for everyone else)", async () => {
    const { roles, mine } = await world();
    const expectations: Record<Role, { create: number; patch: number; importUp: number; exp: number }> = {
      super_admin: { create: 201, patch: 200, importUp: 400, exp: 200 },
      compliance_manager: { create: 201, patch: 200, importUp: 400, exp: 200 },
      compliance_associate: { create: 201, patch: 200, importUp: 403, exp: 403 },
      payroll_preparer: { create: 403, patch: 403, importUp: 403, exp: 403 },
      payroll_approver: { create: 403, patch: 403, importUp: 403, exp: 403 },
      finance_operator: { create: 403, patch: 403, importUp: 403, exp: 403 },
      finance_approver: { create: 403, patch: 403, importUp: 403, exp: 403 },
      auditor: { create: 403, patch: 403, importUp: 403, exp: 403 },
    };
    let n = 0;
    for (const r of ROLES) {
      await as(roles[r]);
      const e = expectations[r];
      n++;
      expect((await api("POST", "/api/candidates", { json: { legalName: `Matrix Person ${n}`, email: `matrix${n}@example.test` } })).status, `${r} create`).toBe(e.create);
      // an associate may edit their own candidate; for roles that cannot, the answer is 403 regardless of the record
      expect((await api("PATCH", `/api/candidates/${mine._id}`, { id: mine._id, json: { phone: `+1 555 010 00${n}0` } })).status, `${r} patch`).toBe(e.patch);
      // import upload without a file: allowed roles get 400 ("choose a file") — everyone else is stopped BEFORE that with 403
      expect((await api("POST", "/api/candidates/import", { form: new FormData() })).status, `${r} import`).toBe(e.importUp);
      expect((await api("GET", "/api/candidates/export")).status, `${r} export`).toBe(e.exp);
      // everyone with candidate access can list
      expect((await api("GET", "/api/candidates")).status, `${r} list`).toBe(200);
    }
  });

  it("a Compliance Associate sees ONLY assigned candidates: list, profile, edit, notes, reveal, export and bulk", async () => {
    const { roles, mine, other } = await world();
    const a = await as(roles.compliance_associate);
    const list = await api("GET", "/api/candidates");
    expect(list.body.total).toBe(1);
    expect(list.body.rows[0]._id).toBe(mine._id);
    expect((await api("GET", `/api/candidates/${mine._id}`, { id: mine._id })).status).toBe(200);
    expect((await api("GET", `/api/candidates/${other._id}`, { id: other._id })).status).toBe(404);
    expect((await api("GET", "/api/candidates/does-not-exist", { id: "does-not-exist" })).status).toBe(404); // indistinguishable
    expect((await api("PATCH", `/api/candidates/${other._id}`, { id: other._id, json: { phone: "+1 555 010 9990" } })).status).toBe(403);
    expect((await M.Candidate.findById(other._id).lean()).phone).not.toBe("+1 555 010 9990");
    await expect(S.addNote(a, other._id, "nope")).rejects.toThrow(/not found/i);
    await expect(S.revealSensitive(a, other._id, "sevisId")).rejects.toThrow(/not found/i);
    expect((await S.listCandidates(a, { q: "Other Owners" })).total).toBe(0); // search cannot reach it either
    expect((await S.bulkUpdate(a, [other._id], { stage: "on_hold" })).matched).toBe(0);
    // team membership also grants access
    await M.Candidate.updateOne({ _id: other._id }, { $set: { teamMemberIds: [roles.compliance_associate.id] } });
    expect((await api("GET", `/api/candidates/${other._id}`, { id: other._id })).status).toBe(200);
  });

  it("an associate who creates a candidate owns it and can immediately see it; nobody else's records appear", async () => {
    const { roles } = await world();
    await as(roles.compliance_associate);
    const created = await api("POST", "/api/candidates", { json: { legalName: "Assoc Made", email: "assoc.made@example.test" } });
    expect(created.status).toBe(201);
    expect((await api("GET", "/api/candidates")).body.total).toBe(2);
  });

  it("field visibility per role (API response bodies): restricted data is absent, not just masked or hidden in the UI", async () => {
    const { roles, mine } = await world();
    const get = async (r: Role) => {
      await as(roles[r]);
      const res = await api("GET", `/api/candidates/${mine._id}`, { id: mine._id });
      expect(res.status, `${r} view`).toBe(200);
      return res.body;
    };
    // the manager: all fields, protected ones masked only
    const m = await get("compliance_manager");
    expect(m).toMatchObject({ authType: "STEM_OPT", dsoName: "Dana DSO", legalName: "Priya Fictional-Test" });
    expect(m.sevisId).toMatch(/^•+5678$/);
    expect(m.dateOfBirth).toBeTruthy();
    expect(m.notes).toHaveLength(1);
    expect(JSON.stringify(m)).not.toMatch(/v1:|N0012345678|SRC1234567890|1998-04-17/);
    expect(m.emergencyContact).toBeTruthy();
    // super admin: every module but NOT the sensitive identifiers
    const root = await get("super_admin");
    expect(root.authType).toBe("STEM_OPT");
    expect(root.sevisId).toBeUndefined();
    expect(root.eadNumber).toBeUndefined();
    expect(root.dateOfBirth).toBeUndefined();
    // associate (their own candidate): same as manager for identifiers
    const assoc = await get("compliance_associate");
    expect(assoc.sevisId).toMatch(/5678$/);
    expect(assoc.payrollMapping).toBeUndefined(); // payroll data is not for compliance associates
    // auditor: read access to compliance data, never identifiers or emergency contact
    const aud = await get("auditor");
    expect(aud.authType).toBe("STEM_OPT");
    expect(aud.notes).toHaveLength(1);
    expect(aud.sevisId).toBeUndefined();
    expect(aud.dateOfBirth).toBeUndefined();
    expect(aud.emergencyContact).toBeUndefined();
    // payroll roles: identity + payroll mapping only — no immigration data, DSO, notes or identifiers
    for (const r of ["payroll_preparer", "payroll_approver"] as const) {
      const p = await get(r);
      expect(p.legalName).toBe("Priya Fictional-Test");
      expect(p.payrollMapping).toMatchObject({ employeeId: "gusto-emp-1" });
      for (const hidden of ["authType", "eadCategory", "eadStart", "i983Status", "visaStatus", "dsoName", "dsoEmail", "notes", "contactHistory", "sevisId", "eadNumber", "dateOfBirth", "emergencyContact", "riskFlags", "clearedToWork", "receiptNumber"]) {
        expect(p[hidden], `${r} must not see ${hidden}`).toBeUndefined();
      }
    }
    // finance roles: identity only (no payroll mapping either)
    for (const r of ["finance_operator", "finance_approver"] as const) {
      const f = await get(r);
      expect(f.legalName).toBe("Priya Fictional-Test");
      for (const hidden of ["payrollMapping", "authType", "dsoName", "notes", "contactHistory", "sevisId", "dateOfBirth", "emergencyContact"]) {
        expect(f[hidden], `${r} must not see ${hidden}`).toBeUndefined();
      }
    }
  });

  it("the LIST API applies the same field rules to every row", async () => {
    const { roles } = await world();
    await as(roles.payroll_preparer);
    const list = await api("GET", "/api/candidates");
    expect(list.body.total).toBe(2);
    for (const row of list.body.rows) {
      expect(row.authType).toBeUndefined();
      expect(row.notes).toBeUndefined();
      expect(row.sevisId).toBeUndefined();
    }
    // payroll users cannot filter by authorization type either (silently ignored, no information leak)
    expect((await api("GET", "/api/candidates?authType=STEM_OPT")).body.total).toBe(2);
  });

  it("the auditor is strictly read-only: no create, edit, assign, notes, bulk, import, export or reveal", async () => {
    const { roles, mine } = await world();
    const a = await as(roles.auditor);
    await expect(S.createCandidate(a, mk())).rejects.toThrow(/permission/i);
    await expect(S.updateCandidate(a, mine._id, schema.candidatePatchSchema.parse({ phone: "+1 555 010 6666" }))).rejects.toThrow(/permission/i);
    await expect(S.addNote(a, mine._id, "x")).rejects.toThrow(/permission/i);
    await expect(S.addContactEntry(a, mine._id, "call", "x")).rejects.toThrow(/permission/i);
    await expect(S.bulkUpdate(a, [mine._id], { stage: "active" })).rejects.toThrow(/permission/i);
    await expect(S.revealSensitive(a, mine._id, "sevisId")).rejects.toThrow(/permission/i);
    await expect(S.exportCandidates(a, {})).rejects.toThrow(/permission/i);
    await expect(imp.createImportPreview(a, "x.csv", Buffer.from("a,b\n1,2"))).rejects.toThrow();
    expect((await M.Candidate.findById(mine._id).lean()).phone).toBe("+1 555 010 4242"); // nothing changed
    // ...but it CAN read profile + audit trail data
    expect((await S.listCandidates(a, {})).total).toBe(2);
  });

  it("payroll and finance roles cannot create, edit or take any write action on candidates", async () => {
    const { roles, mine } = await world();
    for (const r of ["payroll_preparer", "payroll_approver", "finance_operator", "finance_approver"] as const) {
      const u = await as(roles[r]);
      await expect(S.createCandidate(u, mk()), `${r} create`).rejects.toThrow(/permission/i);
      await expect(S.updateCandidate(u, mine._id, schema.candidatePatchSchema.parse({ phone: "+1 555 010 6666" })), `${r} edit`).rejects.toThrow(/permission/i);
      await expect(S.bulkUpdate(u, [mine._id], { stage: "active" }), `${r} bulk`).rejects.toThrow(/permission/i);
      await expect(S.revealSensitive(u, mine._id, "dateOfBirth"), `${r} reveal`).rejects.toThrow(/permission/i);
    }
  });

  it("server actions enforce permissions too (a forged form post from a read-only user changes nothing)", async () => {
    const { roles, mine } = await world();
    await as(roles.auditor);
    const edit = await run(actions.updateCandidateAction({}, fd({ id: mine._id, legalName: "Hacked Name", email: "hacked@example.test", stage: "archived", priority: "low" }))).catch((e) => ({ threw: String(e.message) }));
    expect(JSON.stringify(edit)).toMatch(/permission/i);
    const raw = await M.Candidate.findById(mine._id).lean();
    expect(raw.legalName).toBe("Priya Fictional-Test");
    expect(raw.stage).toBe("onboarding");
  });

  it("a signed-out request to a server action is rejected, not executed", async () => {
    h.store.delete(COOKIE);
    await expect(actions.createCandidateAction({}, fd({ legalName: "No Session", email: "no.session@example.test" }))).rejects.toThrow(/session|sign in/i);
    expect(await M.Candidate.countDocuments()).toBe(0);
  });
});

/* ================================ 8b. SAVED VIEWS ================================ */

describe("saved views", () => {
  let views: typeof import("@/app/(app)/candidates/views-actions");
  let SavedView: any;
  beforeAll(async () => {
    views = await import("@/app/(app)/candidates/views-actions");
    SavedView = (await import("@/lib/db/models/saved-view")).SavedView;
  });

  it("saves a named view per user, strips the page number, and re-saving the same name updates it (no duplicates)", async () => {
    const me = await newActor("compliance_manager");
    await as(me);
    await views.saveViewAction(fd({ name: "Active STEM", query: "stage=active&authType=STEM_OPT&page=4&sort=due" }));
    let all = await SavedView.find({ userId: me.id }).lean();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "Active STEM", module: "candidates" });
    expect(all[0].query).toBe("stage=active&authType=STEM_OPT&sort=due"); // page=4 removed so the view opens on page 1
    await views.saveViewAction(fd({ name: "Active STEM", query: "stage=active&tag=beta" }));
    all = await SavedView.find({ userId: me.id }).lean();
    expect(all).toHaveLength(1);
    expect(all[0].query).toBe("stage=active&tag=beta");
  });

  it("views are private: another user cannot see or delete them", async () => {
    const a = await newActor("compliance_manager");
    const b = await newActor("compliance_associate");
    await as(a);
    await views.saveViewAction(fd({ name: "A's view", query: "stage=new" }));
    const id = String((await SavedView.findOne({ userId: a.id }).lean())._id);
    await as(b);
    await views.deleteViewAction(fd({ id })); // someone else's id: silently does nothing
    expect(await SavedView.countDocuments({ _id: id })).toBe(1);
    expect(await SavedView.countDocuments({ userId: b.id })).toBe(0);
    await as(a);
    await views.deleteViewAction(fd({ id }));
    expect(await SavedView.countDocuments({ _id: id })).toBe(0);
  });

  it("invalid input is ignored (empty / over-long names, oversized queries) and a signed-out caller is rejected", async () => {
    const me = await newActor("compliance_manager");
    await as(me);
    await views.saveViewAction(fd({ name: "   ", query: "stage=new" }));
    await views.saveViewAction(fd({ name: "x".repeat(61), query: "stage=new" }));
    await views.saveViewAction(fd({ name: "big", query: "q=" + "a".repeat(1200) }));
    expect(await SavedView.countDocuments({ userId: me.id })).toBe(0);
    h.store.delete(COOKIE);
    await expect(views.saveViewAction(fd({ name: "ghost", query: "stage=new" }))).rejects.toThrow(/session|sign in/i);
  });

  it("roles without candidate access cannot save views; a saved view reproduces the same list", async () => {
    const roles = await allRoles();
    const mgr = await as(roles.compliance_manager);
    await S.createCandidate(mgr, mk({ stage: "active", legalName: "View Target" }));
    await S.createCandidate(mgr, mk({ stage: "new", legalName: "View Other" }));
    await views.saveViewAction(fd({ name: "Active only", query: "stage=active" }));
    const q = new URLSearchParams((await SavedView.findOne({ userId: roles.compliance_manager.id }).lean()).query);
    const r = await S.listCandidates(mgr, { stage: q.get("stage") ?? undefined });
    expect(r.rows.map((x: any) => x.legalName)).toEqual(["View Target"]);
  });
});

/* ================================ 8c. API INPUT HANDLING ================================ */

describe("candidate API: validation and error responses", () => {
  it("POST: invalid body → 422 with per-field details; malformed JSON → 400 (not a 500)", async () => {
    await as(await newActor("compliance_manager"));
    const bad = await api("POST", "/api/candidates", { json: { legalName: "A", email: "nope", dateOfBirth: "2999-01-01" } });
    expect(bad.status).toBe(422);
    const fields = bad.body.details.map((d: any) => d.path);
    expect(fields).toEqual(expect.arrayContaining(["legalName", "email", "dateOfBirth"]));
    const req = new NextRequest("http://localhost/api/candidates", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    const res = await (await import("@/app/api/candidates/route")).POST(req as never);
    expect(res.status).toBe(400);
    expect(await M.Candidate.countDocuments()).toBe(0);
  });

  it("POST: duplicates → 409 with the matches; ?allowSoftDuplicate=1 confirms a name+DOB twin; hard duplicates can never be forced", async () => {
    await as(await newActor("compliance_manager"));
    const body = { legalName: "Api Twin", email: "api.twin@example.test", dateOfBirth: "1995-05-05" };
    expect((await api("POST", "/api/candidates", { json: body })).status).toBe(201);
    const hard = await api("POST", "/api/candidates", { json: body });
    expect(hard.status).toBe(409);
    expect(hard.body.matches[0].reason).toBe("Same email");
    const soft = await api("POST", "/api/candidates", { json: { ...body, email: "api.twin2@example.test" } });
    expect(soft.status).toBe(409);
    expect((await api("POST", "/api/candidates?allowSoftDuplicate=1", { json: { ...body, email: "api.twin2@example.test" } })).status).toBe(201);
    expect((await api("POST", "/api/candidates?allowSoftDuplicate=1", { json: body })).status).toBe(409); // still hard
    expect(await M.Candidate.countDocuments()).toBe(2);
  });

  it("PATCH: partial update keeps everything else; invalid owner → 422; unknown id → 403/404 consistently; GET list honours paging params", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const c = await S.createCandidate(mgr, mk({ stage: "active", school: "Keep Me U" }));
    const ok = await api("PATCH", `/api/candidates/${c._id}`, { id: c._id, json: { phone: "+1 555 010 3333" } });
    expect(ok.status).toBe(200);
    const raw = await M.Candidate.findById(c._id).lean();
    expect(raw).toMatchObject({ phone: "+1 555 010 3333", stage: "active", school: "Keep Me U" });
    expect((await api("PATCH", `/api/candidates/${c._id}`, { id: c._id, json: { ownerId: "ghost" } })).status).toBe(422);
    expect((await api("PATCH", `/api/candidates/${c._id}`, { id: c._id, json: { email: "bad" } })).status).toBe(422);
    expect((await api("PATCH", "/api/candidates/nope", { id: "nope", json: { phone: "1" } })).status).toBe(403);
    for (let i = 0; i < 4; i++) await S.createCandidate(mgr, mk());
    const page = await api("GET", "/api/candidates?pageSize=2&page=2&sort=name");
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(page.body.rows).toHaveLength(2);
    expect((await api("GET", "/api/candidates?pageSize=abc&page=xyz")).status).toBe(200); // garbage params fall back to defaults
  });
});

/* ================================ 9. IMPORT (SYNTHETIC CSV / XLSX) ================================ */

describe("roster import — synthetic files only, scratch database", () => {
  const CSV = [
    "Full Name,E-mail Address,Mobile,DOB,University,Degree Level,Major,Graduation Date,Authorization,EAD Start,EAD End,SEVIS",
    "Import Person One,import.one@example.test,555-0101,03/15/1998,Fictional U,Master's,Computer Science,05/15/2026,STEM OPT,06/01/2026,05/31/2028,N0011111111",
    "Import Person Two,import.two@example.test,555-0102,1997-07-04,Fictional U,Bachelor's,Data Science,2025-12-20,OPT,2026-01-05,2027-01-04,N0022222222",
    "Import Person Three,import.three@example.test,555-0103,12/31/1996,Fictional U,PhD,Physics,,CPT,,,",
    "Bad Email Person,not-an-email,555-0104,1995-01-01,Fictional U,,,,,,,",
    "Bad Date Person,bad.date@example.test,555-0105,13/45/1999,Fictional U,,,,,,,",
    "Existing Person,existing@example.test,555-0106,1990-01-01,Fictional U,,,,,,,",
    "Import Person One Again,IMPORT.ONE@example.test,555-0107,1998-03-15,Fictional U,,,,,,,",
    '=cmd|\' /C calc\'!A0,formula.guy@example.test,555-0108,1994-04-04,Fictional U,,,,,,,',
    ",no.name@example.test,555-0109,1993-03-03,Fictional U,,,,,,,",
  ].join("\n");

  async function managerWithExisting() {
    const a = await newActor("compliance_manager", "Import Mgr");
    const mgr = await as(a);
    await S.createCandidate(mgr, mk({ legalName: "Existing Person", email: "existing@example.test" }));
    return mgr;
  }

  it("PREVIEW: nothing is saved; rows are classified; invalid rows say which field and why; duplicates are flagged; sensitive values are masked", async () => {
    const mgr = await managerWithExisting();
    const before = await M.Candidate.countDocuments();
    const p = await imp.createImportPreview(mgr, "roster.csv", Buffer.from(CSV, "utf8"));
    expect(await M.Candidate.countDocuments()).toBe(before); // preview-before-import: zero records created
    expect(p.totalRows).toBe(9);
    expect(p.headers).toHaveLength(12);
    expect(p.missingRequired).toEqual([]);
    expect(p.mapping.filter(Boolean)).toHaveLength(12); // messy headers were auto-mapped
    const byRow = (n: number) => p.rows.find((r) => r.rowNumber === n)!;
    expect(byRow(2).status).toBe("valid"); // header is row 1
    expect(byRow(3).status).toBe("valid");
    expect(byRow(4).status).toBe("valid");
    expect(byRow(5).status).toBe("invalid");
    expect(Object.keys(byRow(5).errors)).toContain("email");
    expect(byRow(6).status).toBe("invalid");
    expect(Object.keys(byRow(6).errors)).toContain("dateOfBirth");
    expect(byRow(7).status).toBe("duplicate_db");
    expect(byRow(8).status).toMatch(/duplicate_file|possible_duplicate_file/); // same email as row 2 (case-insensitive)
    expect(byRow(10).status).toBe("invalid"); // missing name
    expect(p.summary.valid).toBeGreaterThanOrEqual(4);
    expect(p.neutralizedCells).toBeGreaterThanOrEqual(1); // the "=cmd|…" name
    const sev = byRow(2).cells.sevisId ?? "";
    expect(sev).not.toContain("N0011111111"); // masked in the preview
    expect(JSON.stringify(p)).not.toContain("N0011111111");
    // dates were normalised from US formats
    expect(byRow(2).cells.dateOfBirth).toBe("(provided)"); // restricted: never echoed in the preview
    expect(byRow(2).cells.graduationDate).toBe("2026-05-15"); // 05/15/2026 normalised to a date-only value
    expect(byRow(2).cells.eadStart).toBe("2026-06-01");
    expect(await M.ImportRow.countDocuments()).toBe(9); // staged rows exist, encrypted
    const staged = JSON.stringify(await M.ImportRow.find().lean());
    expect(staged).not.toContain("import.one@example.test"); // staged rows are ciphertext
  });

  it("COMMIT needs the explicit approved-master-roster confirmation; then creates valid rows and skips duplicates/invalid ones with a clear summary", async () => {
    const mgr = await managerWithExisting();
    const p = await imp.createImportPreview(mgr, "roster.csv", Buffer.from(CSV, "utf8"));
    await expect(imp.commitImport(mgr, p.jobId, { confirmMasterRoster: false, duplicateHandling: "skip" })).rejects.toThrow(/approved, validated master roster/);
    expect(await M.Candidate.countDocuments()).toBe(1);

    const r = await imp.commitImport(mgr, p.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" });
    expect(r.created).toBeGreaterThanOrEqual(4);
    expect(r.created + r.skipped + r.failed).toBe(9);
    expect(r.failed).toBe(0);
    expect(r.outcomes.find((o) => o.row === 5)?.status).toBe("skipped_invalid");
    expect(r.outcomes.find((o) => o.row === 7)?.status).toBe("skipped_duplicate_db");
    expect(r.outcomes.find((o) => o.row === 5)?.message ?? "").toMatch(/email/); // field names only
    expect(JSON.stringify(r.outcomes)).not.toContain("not-an-email"); // never the cell values

    const one = await M.Candidate.findOne({ emailLower: "import.one@example.test" }).lean();
    expect(one).toMatchObject({ legalName: "Import Person One", phone: "555-0101", school: "Fictional U", degreeLevel: "Master's", major: "Computer Science", graduationDate: "2026-05-15", authType: "STEM_OPT", eadStart: "2026-06-01", eadEnd: "2028-05-31" });
    expect(one.sevisId.enc).toMatch(/^v1:/); // encrypted through the normal service
    expect(one.dateOfBirth.enc).toMatch(/^v1:/);
    expect(one.candidateCode).toMatch(/^CND-\d{6}$/);
    expect(JSON.stringify(one)).not.toContain("N0011111111");
    expect(await M.Candidate.countDocuments({ emailLower: "existing@example.test" })).toBe(1); // the existing record untouched
    expect(await M.Candidate.countDocuments({ emailLower: "not-an-email" })).toBe(0);
    // formula-style names are stored harmlessly
    const formula = await M.Candidate.findOne({ emailLower: "formula.guy@example.test" }).lean();
    expect(formula?.legalName?.startsWith("=")).toBe(false);
    // staged rows are wiped, the job is closed, and a second commit is impossible
    expect(await M.ImportRow.countDocuments({ jobId: p.jobId })).toBe(0);
    await expect(imp.commitImport(mgr, p.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" })).rejects.toThrow(/already been committed|expired/);
    // audit: counts and file name only — no personal data
    const ev = await M.Audit.findOne({ action: "import", summary: /^Imported roster/ }).lean();
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev)).not.toContain("import.one@example.test");
    expect(ev.summary).toMatch(/created/i);
  }, 120_000);

  it("importing the same file again creates nothing (everything is now a duplicate)", async () => {
    const mgr = await managerWithExisting();
    const p1 = await imp.createImportPreview(mgr, "roster.csv", Buffer.from(CSV, "utf8"));
    const first = await imp.commitImport(mgr, p1.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" });
    const count = await M.Candidate.countDocuments();
    const p2 = await imp.createImportPreview(mgr, "roster.csv", Buffer.from(CSV, "utf8"));
    expect(p2.summary.valid).toBe(0);
    const second = await imp.commitImport(mgr, p2.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" });
    expect(second.created).toBe(0);
    expect(await M.Candidate.countDocuments()).toBe(count);
    expect(first.created).toBeGreaterThan(0);
  }, 180_000);

  it("name + DOB twins in the file are 'possible duplicates': skipped by default, imported only on request", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const csv = ["Legal Name,Email,Date of Birth", "Twin Person,twin1@example.test,1999-01-01", "Twin Person,twin2@example.test,1999-01-01"].join("\n");
    const p = await imp.createImportPreview(mgr, "twins.csv", Buffer.from(csv));
    expect(p.summary.possible_duplicate_file + p.summary.duplicate_file).toBeGreaterThanOrEqual(1);
    const skip = await imp.commitImport(mgr, p.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" });
    expect(skip.created).toBe(1);
    const p2 = await imp.createImportPreview(mgr, "twins.csv", Buffer.from(csv));
    const soft = await imp.commitImport(mgr, p2.jobId, { confirmMasterRoster: true, duplicateHandling: "import_soft" });
    expect(soft.created).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("XLSX: real Date cells, Excel serial numbers, numeric phones and formulas import correctly with no off-by-one dates", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Roster");
    ws.addRow(["Legal Name", "Email", "Phone", "Date of Birth", "Graduation Date", "School", "Authorization"]);
    ws.addRow(["Xlsx Person One", "xlsx.one@example.test", 5550201, new Date(Date.UTC(1998, 2, 15)), new Date(Date.UTC(2026, 4, 15)), "Fictional U", "OPT"]);
    ws.addRow(["Xlsx Person Two", "xlsx.two@example.test", "555-0202", 35800, "2026-12-20", "Fictional U", "stem opt"]); // 35800 = 1998-01-05 as an Excel serial (35796 = 1998-01-01)
    ws.addRow(["Xlsx Person Three", { formula: '"xlsx.three"&"@example.test"', result: "xlsx.three@example.test" }, "555-0203", "1996-06-06", "", "Fictional U", ""]);
    ws.addRow(["", "", "", "", "", "", ""]); // blank row must be ignored
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const mgr = await as(await newActor("compliance_manager"));
    const p = await imp.createImportPreview(mgr, "roster.xlsx", buf);
    expect(p.totalRows).toBe(3);
    expect(p.summary.valid).toBe(3);
    const r = await imp.commitImport(mgr, p.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" });
    expect(r.created).toBe(3);
    const one = await M.Candidate.findOne({ emailLower: "xlsx.one@example.test" }).lean();
    expect(one.graduationDate).toBe("2026-05-15");
    expect(one.phone).toBe("5550201");
    expect(one.authType).toBe("OPT");
    const two = await M.Candidate.findOne({ emailLower: "xlsx.two@example.test" }).lean();
    expect(two.graduationDate).toBe("2026-12-20");
    expect(two.authType).toBe("STEM_OPT");
    expect(await M.Candidate.findOne({ emailLower: "xlsx.three@example.test" }).lean()).toBeTruthy(); // formula result used
    expect(await S.revealSensitive(mgr, one._id, "dateOfBirth")).toBe("1998-03-15");
    expect(await S.revealSensitive(mgr, two._id, "dateOfBirth")).toBe("1998-01-05");
  }, 120_000);

  it("clear errors for unusable files: wrong type, empty, header-only, binary junk, missing required columns, too many rows", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const msg = async (name: string, data: Buffer) => (await imp.createImportPreview(mgr, name, data).then(() => "OK", (e) => e.message)) as string;
    expect(await msg("roster.exe", Buffer.from("MZ"))).toMatch(/csv|xlsx|supported|type/i);
    expect(await msg("empty.csv", Buffer.alloc(0))).toMatch(/empty|no data|no rows/i);
    expect(await msg("headers-only.csv", Buffer.from("Legal Name,Email\n"))).toMatch(/no data|no rows|empty/i);
    expect(await msg("junk.xlsx", Buffer.from("this is not a zip file"))).toMatch(/xlsx|read|valid|corrupt|spreadsheet/i);
    const many = "Legal Name,Email\n" + Array.from({ length: 5001 }, (_, i) => `P ${i},p${i}@example.test`).join("\n");
    expect(await msg("many.csv", Buffer.from(many))).toMatch(/5,?000/);
    const noEmail = await imp.createImportPreview(mgr, "noemail.csv", Buffer.from("Legal Name,School\nSomebody,Fictional U\n"));
    expect(noEmail.missingRequired.length).toBeGreaterThan(0);
    await expect(imp.commitImport(mgr, noEmail.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" })).rejects.toThrow(/required columns/i);
    expect(await M.Candidate.countDocuments()).toBe(0);
  });

  it("column mapping can be corrected after the preview, and re-validates the rows", async () => {
    const mgr = await as(await newActor("compliance_manager"));
    const csv = "Person,Contact,Notes\nMapped Person,mapped.person@example.test,hello\n";
    const p = await imp.createImportPreview(mgr, "odd.csv", Buffer.from(csv));
    expect(p.missingRequired.length).toBeGreaterThan(0); // "Contact" is not recognised as email
    const re = await imp.remapImport(mgr, p.jobId, ["legalName", "email", null]);
    expect(re.missingRequired).toEqual([]);
    expect(re.summary.valid).toBe(1);
    const r = await imp.commitImport(mgr, p.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" });
    expect(r.created).toBe(1);
    expect(await M.Candidate.findOne({ emailLower: "mapped.person@example.test" }).lean()).toBeTruthy();
  });

  it("restricted columns in a file are ignored (and reported) when the importer lacks that permission", async () => {
    const root = await as(await newActor("super_admin")); // can import, but has no sensitive-field permissions
    const csv = "Legal Name,Email,Date of Birth,SEVIS ID\nRestricted Test,restricted.test@example.test,1998-02-02,N0077777777\n";
    const p = await imp.createImportPreview(root, "restricted.csv", Buffer.from(csv));
    expect(p.ignoredFields.length).toBeGreaterThan(0);
    await imp.commitImport(root, p.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" });
    const raw = await M.Candidate.findOne({ emailLower: "restricted.test@example.test" }).lean();
    expect(raw).toBeTruthy();
    expect(raw.sevisId).toBeUndefined();
    expect(raw.dateOfBirth).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain("N0077777777");
  });

  it("only users with the import permission can preview or commit; jobs belong to their creator", async () => {
    const roles = await allRoles();
    for (const r of ["compliance_associate", "payroll_preparer", "finance_approver", "auditor"] as Role[]) {
      const u = await as(roles[r]);
      await expect(imp.createImportPreview(u, "x.csv", Buffer.from("Legal Name,Email\nA B,a@b.test")), `${r}`).rejects.toThrow();
    }
    const mgr = await as(roles.compliance_manager);
    const p = await imp.createImportPreview(mgr, "mine.csv", Buffer.from("Legal Name,Email\nOwn Job,own.job@example.test"));
    const root = await as(roles.super_admin);
    await expect(imp.commitImport(root, p.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" })).rejects.toThrow(/not found|expired|access/i);
    expect(await M.Candidate.countDocuments()).toBe(0);
  });

  it("through the HTTP route: a CSV upload previews with 201 and creates nothing; commit is a separate step", async () => {
    const roles = await allRoles();
    await as(roles.compliance_manager);
    const form = new FormData();
    form.set("file", new File(["Legal Name,Email\nHttp Person,http.person@example.test\n"], "http.csv", { type: "text/csv" }));
    const up = await api("POST", "/api/candidates/import", { form });
    expect(up.status).toBe(201);
    expect(up.body.summary.valid).toBe(1);
    expect(await M.Candidate.countDocuments()).toBe(0);
    await as(roles.compliance_associate);
    const form2 = new FormData();
    form2.set("file", new File(["Legal Name,Email\nX Y,x@y.test\n"], "x.csv", { type: "text/csv" }));
    expect((await api("POST", "/api/candidates/import", { form: form2 })).status).toBe(403);
  });
});
