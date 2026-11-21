import { describe, expect, it } from "vitest";
import { decryptField, encryptField, maskValue, protectField, revealField } from "@/lib/crypto/field";
import { checkPasswordStrength, hashPassword, verifyPassword } from "@/lib/auth/password";

describe("field encryption", () => {
  it("round-trips and never stores plaintext", () => {
    const enc = encryptField("N0012345678");
    expect(enc).not.toContain("N0012345678");
    expect(decryptField(enc)).toBe("N0012345678");
  });
  it("uses a fresh IV each time", () => {
    expect(encryptField("same")).not.toBe(encryptField("same"));
  });
  it("detects tampering (GCM auth tag)", () => {
    const parts = encryptField("secret").split(":");
    parts[3] = Buffer.from("tampered!!").toString("base64url");
    expect(() => decryptField(parts.join(":"))).toThrow();
  });
  it("masks all but last 4", () => {
    expect(maskValue("1234567890")).toMatch(/^•+7890$/);
    expect(maskValue("123")).toBe("•••");
  });
  it("protectField keeps only ciphertext + mask", () => {
    const p = protectField("SEVIS-123456789")!;
    expect(JSON.stringify(p)).not.toContain("SEVIS-123456789");
    expect(revealField(p)).toBe("SEVIS-123456789");
    expect(protectField("  ")).toBeUndefined();
  });
});

describe("passwords", () => {
  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword("Correct-Horse-9!");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("Correct-Horse-9!", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("enforces policy", () => {
    expect(checkPasswordStrength("short").ok).toBe(false);
    expect(checkPasswordStrength("alllowercase1234!").ok).toBe(false);
    expect(checkPasswordStrength("Str0ng-Enough-Pass!").ok).toBe(true);
  });
});
