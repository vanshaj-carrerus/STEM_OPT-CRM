import { describe, expect, it } from "vitest";
import { candidateCreateSchema, candidatePatchSchema } from "@/lib/candidates/schema";
import { csvEscape } from "@/lib/csv";
import { nameDobHashOf, sevisHashOf } from "@/lib/candidates/service";

describe("candidate schemas", () => {
  it("create applies defaults", () => {
    const r = candidateCreateSchema.parse({ legalName: "Asha Rao", email: "ASHA@Example.com" });
    expect(r).toMatchObject({ email: "asha@example.com", stage: "new", priority: "normal", authType: "none" });
  });

  it("PATCH never applies defaults, so omitted fields are not reset (regression)", () => {
    const r = candidatePatchSchema.parse({ phone: "555-1111" });
    expect(r.stage).toBeUndefined();
    expect(r.authType).toBeUndefined();
    expect(r.priority).toBeUndefined();
    expect(r.i983Status).toBeUndefined();
  });

  it("treats empty strings as undefined and validates date-only values", () => {
    expect(candidatePatchSchema.parse({ phone: "" }).phone).toBeUndefined();
    expect(candidatePatchSchema.safeParse({ eadStart: "2026-02-31" }).success).toBe(false);
    expect(candidatePatchSchema.safeParse({ eadStart: "2026-06-01", eadEnd: "2026-05-01" }).success).toBe(false);
    expect(candidatePatchSchema.safeParse({ eadStart: "2026-06-01", eadEnd: "2027-05-31" }).success).toBe(true);
  });

  it("rejects bad email and missing required fields on create", () => {
    expect(candidateCreateSchema.safeParse({ legalName: "A", email: "x" }).success).toBe(false);
  });
});

describe("duplicate-detection hashes (no plaintext stored)", () => {
  it("are stable, case/space-insensitive and don't contain the input", () => {
    expect(sevisHashOf(" n0012345678 ")).toBe(sevisHashOf("N0012345678"));
    expect(sevisHashOf("N0012345678")).not.toContain("0012345678");
    expect(nameDobHashOf("Asha  Rao", "2000-01-01")).not.toBe(nameDobHashOf("Asha Rao", "2000-01-02"));
    expect(nameDobHashOf("ASHA RAO", "2000-01-01")).toBe(nameDobHashOf("asha rao", "2000-01-01"));
  });
});

describe("csv escaping", () => {
  it("quotes commas/quotes/newlines and neutralises formula injection", () => {
    expect(csvEscape('a,"b"')).toBe('"a,""b"""');
    expect(csvEscape("=cmd|' /C calc'!A0")).toMatch(/^'=/);
    expect(csvEscape("+1")).toBe("'+1");
    expect(csvEscape(null)).toBe("");
  });
});
