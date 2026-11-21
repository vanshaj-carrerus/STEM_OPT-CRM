import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestDb, stopTestDb } from "../helpers/db";
import type { SessionUser } from "@/lib/auth/session";

const user = (id: string, role: SessionUser["role"]) => ({ id, role, email: `${id}@x.test`, name: id, timezone: "America/New_York", mustChangePassword: false, sessionId: "s" }) as unknown as SessionUser;
const pdf = (s: string) => Buffer.from(`%PDF-1.7 ${s}`);

describe("document vault invariants (needs MongoDB)", () => {
  beforeAll(async () => {
    process.env.DOCS_DIR = mkdtempSync(join(tmpdir(), "crm-vault-"));
    await startTestDb();
  });
  afterAll(stopTestDb);

  async function seedCandidate(ownerId: string) {
    const { Candidate } = await import("@/lib/db/models/candidate");
    return Candidate.create({ candidateCode: `CND-${Math.random()}`, legalName: "Test Person", email: `t${Math.random()}@x.test`, emailLower: `t${Math.random()}@x.test`, authType: "OPT", ownerId });
  }

  it("re-upload creates version 2, flips isLatest, keeps v1 and resets review", async () => {
    const { uploadDocument, reviewDocument, listCandidateDocuments } = await import("@/lib/documents/service");
    const mgr = user("mgr", "compliance_manager");
    const uploader = user("up", "compliance_associate");
    const c = await seedCandidate("up");
    const v1 = await uploadDocument(mgr, c._id, { fileName: "p.pdf", data: pdf("a"), meta: { type: "passport" } as never });
    await reviewDocument(user("rev", "compliance_manager"), { documentId: v1.id, decision: "verified" });
    const v2 = await uploadDocument(mgr, c._id, { fileName: "p2.pdf", data: pdf("b"), meta: { groupId: v1.groupId } as never });
    expect(v2.version).toBe(2);
    expect(v2.verification).toBe("pending_review");
    const [g] = await listCandidateDocuments(mgr, c._id);
    expect(g.latest.id).toBe(v2.id);
    expect(g.history.map((h) => h.id)).toEqual([v1.id]);
    expect(g.history[0].isLatest).toBe(false);
    void uploader;
  });

  it("uploader cannot verify their own upload unless manager", async () => {
    const { uploadDocument, reviewDocument } = await import("@/lib/documents/service");
    const assoc = user("assoc", "compliance_associate");
    const c = await seedCandidate("assoc");
    const d = await uploadDocument(assoc, c._id, { fileName: "p.pdf", data: pdf("c"), meta: { type: "passport" } as never });
    await expect(reviewDocument(assoc, { documentId: d.id, decision: "verified" })).rejects.toThrow(/different reviewer/);
    await expect(reviewDocument(user("other", "compliance_associate"), { documentId: d.id, decision: "verified" })).rejects.toThrow(/not found/i); // no record access
  });

  it("restricted documents are invisible without sensitive.tax.view and downloads need documents.download", async () => {
    const { uploadDocument, listCandidateDocuments, getDownloadableDocument } = await import("@/lib/documents/service");
    const owner = user("own", "compliance_manager");
    const withTax = { ...owner, extraPermissions: ["sensitive.tax.view"] } as SessionUser;
    const c = await seedCandidate("own");
    await expect(uploadDocument(owner, c._id, { fileName: "w4.pdf", data: pdf("d"), meta: { type: "w4" } as never })).rejects.toThrow(/payroll/i);
    const w4 = await uploadDocument(withTax, c._id, { fileName: "w4.pdf", data: pdf("d"), meta: { type: "w4" } as never });
    expect((await listCandidateDocuments(owner, c._id)).some((g) => g.type === "w4")).toBe(false);
    await expect(getDownloadableDocument(owner, w4.id)).rejects.toThrow(/not found/i);
    await expect(getDownloadableDocument(withTax, w4.id)).resolves.toMatchObject({ _id: w4.id });
    await expect(getDownloadableDocument(user("aud", "auditor"), w4.id)).rejects.toThrow(); // view-only role
  });

  it("getVerifiedDocument only returns verified docs belonging to the candidate", async () => {
    const { uploadDocument, reviewDocument, getVerifiedDocument } = await import("@/lib/documents/service");
    const mgr = user("m2", "compliance_manager");
    const c = await seedCandidate("m2");
    const other = await seedCandidate("m2");
    const d = await uploadDocument(mgr, c._id, { fileName: "i.pdf", data: pdf("e"), meta: { type: "i20" } as never });
    expect(await getVerifiedDocument(c._id, d.id)).toBeNull();
    await reviewDocument(mgr, { documentId: d.id, decision: "verified" });
    expect(await getVerifiedDocument(c._id, d.id)).toMatchObject({ _id: d.id });
    expect(await getVerifiedDocument(other._id, d.id)).toBeNull();
  });
});
