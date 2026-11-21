import { describe, expect, it } from "vitest";
import {
  assertReviewerAllowed,
  canPreviewInline,
  computeMissing,
  contentDisposition,
  contentTypeFor,
  displayStatus,
  isExpired,
  isRestrictedType,
  nextVersion,
  satisfiesRequirement,
  validateReview,
  type RuleDoc,
} from "@/lib/documents/rules";
import { uploadMetaSchema } from "@/lib/documents/schema";
import { SeparationOfDutiesError } from "@/lib/sod";

const TODAY = "2026-11-21";
const doc = (over: Partial<RuleDoc>): RuleDoc => ({ type: "passport", isLatest: true, verification: "verified", expiryDate: null, ...over });

describe("document versioning", () => {
  it("starts at 1 and always increments past the highest existing version", () => {
    expect(nextVersion([])).toBe(1);
    expect(nextVersion([1])).toBe(2);
    expect(nextVersion([1, 2, 3])).toBe(4);
    expect(nextVersion([3, 1, 2])).toBe(4); // order-independent
  });
});

describe("expiry", () => {
  it("is valid through the expiry date and expired the day after", () => {
    expect(isExpired("2026-11-21", TODAY)).toBe(false);
    expect(isExpired("2026-11-20", TODAY)).toBe(true);
    expect(isExpired(undefined, TODAY)).toBe(false);
  });
  it("shows expired unless rejected", () => {
    expect(displayStatus({ verification: "verified", expiryDate: "2026-01-01" }, TODAY)).toBe("expired");
    expect(displayStatus({ verification: "pending_review", expiryDate: "2026-01-01" }, TODAY)).toBe("expired");
    expect(displayStatus({ verification: "rejected", expiryDate: "2026-01-01" }, TODAY)).toBe("rejected");
    expect(displayStatus({ verification: "verified", expiryDate: "2027-01-01" }, TODAY)).toBe("verified");
  });
});

describe("required-document checklist (missing documents)", () => {
  it("lists every required type when nothing is uploaded", () => {
    const missing = computeMissing("CPT", [], TODAY);
    expect(missing.map((m) => m.type)).toEqual(["passport", "i20", "offer_letter", "job_description"]);
    expect(missing.every((m) => m.reason === "not_uploaded")).toBe(true);
  });
  it("is satisfied only by a latest, verified, non-expired document", () => {
    expect(satisfiesRequirement(doc({}), TODAY)).toBe(true);
    expect(satisfiesRequirement(doc({ isLatest: false }), TODAY)).toBe(false);
    expect(satisfiesRequirement(doc({ verification: "pending_review" }), TODAY)).toBe(false);
    expect(satisfiesRequirement(doc({ expiryDate: "2026-11-01" }), TODAY)).toBe(false);
  });
  it("reports the most useful reason for an unsatisfied type", () => {
    const m = (docs: RuleDoc[]) => computeMissing("none", docs, TODAY, ["passport"])[0]?.reason;
    expect(m([doc({ verification: "pending_review" })])).toBe("pending_review");
    expect(m([doc({ verification: "rejected" })])).toBe("rejected");
    expect(m([doc({ expiryDate: "2026-01-01" })])).toBe("expired");
    expect(m([doc({ verification: "pending_review" }), doc({ verification: "rejected", isLatest: false })])).toBe("pending_review");
    expect(m([])).toBe("not_uploaded");
  });
  it("ignores superseded versions: a verified old version does not satisfy a new unreviewed one", () => {
    const docs = [doc({ isLatest: false, verification: "verified" }), doc({ isLatest: true, verification: "pending_review" })];
    expect(computeMissing("none", docs, TODAY, ["passport"]).map((x) => x.reason)).toEqual(["pending_review"]);
  });
  it("is complete when every required type has a valid verified document", () => {
    const docs = ["passport", "resume"].map((type) => doc({ type }));
    expect(computeMissing("none", docs, TODAY)).toEqual([]);
  });
  it("uses the checklist for the candidate's authorization type", () => {
    expect(computeMissing("STEM_OPT", [], TODAY).map((m) => m.type)).toContain("i983");
    expect(computeMissing("OPT", [], TODAY).map((m) => m.type)).not.toContain("i983");
  });
});

describe("verification state machine", () => {
  const base = { isLatest: true, today: TODAY, expiryDate: null as string | null };
  it("allows pending_review -> verified | rejected", () => {
    expect(validateReview({ ...base, from: "pending_review", decision: "verified" })).toBeNull();
    expect(validateReview({ ...base, from: "pending_review", decision: "rejected", note: "Blurry scan" })).toBeNull();
  });
  it("requires a note to reject", () => {
    expect(validateReview({ ...base, from: "pending_review", decision: "rejected" })).toMatch(/note is required/i);
    expect(validateReview({ ...base, from: "pending_review", decision: "rejected", note: "  " })).toMatch(/note is required/i);
  });
  it("does not allow re-reviewing a decided version or reviewing a superseded one", () => {
    expect(validateReview({ ...base, from: "verified", decision: "rejected", note: "x".repeat(5) })).toMatch(/already been reviewed/);
    expect(validateReview({ ...base, from: "rejected", decision: "verified" })).toMatch(/already been reviewed/);
    expect(validateReview({ ...base, isLatest: false, from: "pending_review", decision: "verified" })).toMatch(/latest version/);
  });
  it("will not verify an already-expired document", () => {
    expect(validateReview({ ...base, expiryDate: "2026-01-01", from: "pending_review", decision: "verified" })).toMatch(/expiry/);
  });
});

describe("reviewer separation", () => {
  it("blocks reviewers from verifying their own upload", () => {
    expect(() => assertReviewerAllowed("u1", "compliance_associate", "u1")).toThrow(SeparationOfDutiesError);
    expect(() => assertReviewerAllowed("u1", "auditor", "u1")).toThrow(SeparationOfDutiesError);
  });
  it("lets a different user review", () => {
    expect(() => assertReviewerAllowed("u2", "compliance_associate", "u1")).not.toThrow();
  });
  it("lets compliance managers and super admins review their own upload", () => {
    expect(() => assertReviewerAllowed("u1", "compliance_manager", "u1")).not.toThrow();
    expect(() => assertReviewerAllowed("u1", "super_admin", "u1")).not.toThrow();
  });
});

describe("restricted categories", () => {
  it("flags payroll/tax types as restricted", () => {
    expect(isRestrictedType("w4")).toBe(true);
    expect(isRestrictedType("payroll_record")).toBe(true);
    expect(isRestrictedType("passport")).toBe(false);
    expect(isRestrictedType("nonexistent")).toBe(false);
  });
});

describe("file serving helpers", () => {
  it("derives the content type from the extension", () => {
    expect(contentTypeFor("scan.PDF")).toBe("application/pdf");
    expect(contentTypeFor("a.jpeg")).toBe("image/jpeg");
    expect(contentTypeFor("a.docx")).toContain("wordprocessingml");
    expect(contentTypeFor("a.exe")).toBe("application/octet-stream");
  });
  it("only allows PDF/PNG/JPEG inline", () => {
    expect(canPreviewInline("application/pdf")).toBe(true);
    expect(canPreviewInline("image/png")).toBe(true);
    expect(canPreviewInline("text/html")).toBe(false);
    expect(canPreviewInline(contentTypeFor("a.docx"))).toBe(false);
  });
  it("builds a safe Content-Disposition without header injection", () => {
    const h = contentDisposition('evil"\r\nX-Injected: 1.pdf', false);
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.startsWith("attachment;")).toBe(true);
    expect(contentDisposition("résumé.pdf", true).startsWith("inline;")).toBe(true);
  });
});

describe("upload metadata schema", () => {
  it("requires a type for a new document but not for a new version", () => {
    expect(uploadMetaSchema.safeParse({}).success).toBe(false);
    expect(uploadMetaSchema.safeParse({ type: "bogus" }).success).toBe(false);
    expect(uploadMetaSchema.safeParse({ type: "passport" }).success).toBe(true);
    expect(uploadMetaSchema.safeParse({ groupId: "g1" }).success).toBe(true);
  });
  it("validates date-only fields and their order; blanks become undefined", () => {
    expect(uploadMetaSchema.safeParse({ type: "passport", expiryDate: "2026-13-40" }).success).toBe(false);
    expect(uploadMetaSchema.safeParse({ type: "passport", issueDate: "2026-05-01", expiryDate: "2026-01-01" }).success).toBe(false);
    const ok = uploadMetaSchema.parse({ type: "passport", expiryDate: "", employerId: "" });
    expect(ok.expiryDate).toBeUndefined();
    expect(ok.employerId).toBeUndefined();
  });
});
