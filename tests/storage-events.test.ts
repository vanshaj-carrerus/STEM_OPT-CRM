import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEncryptedStorage, cleanFileName, defaultScanner, newObjectKey, signDownloadToken, verifyDownloadToken } from "@/lib/storage";
import { signForTest, verifySignature } from "@/lib/integrations/events";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "crm-docs-"));
  process.env.DOCS_DIR = dir;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("encrypted document storage", () => {
  it("round-trips, stores ciphertext (not plaintext) and refuses overwrite", async () => {
    const s = new LocalEncryptedStorage();
    const key = newObjectKey("cand-1");
    const data = Buffer.from("%PDF-1.4 secret passport scan");
    await s.put(key, data);
    expect((await s.get(key)).equals(data)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(dir, key)).includes(Buffer.from("secret passport"))).toBe(false);
    await expect(s.put(key, data)).rejects.toThrow();
  });
  it("rejects path traversal keys", async () => {
    const s = new LocalEncryptedStorage();
    await expect(s.get("../etc/passwd")).rejects.toThrow(/Invalid storage key/);
    await expect(s.put("a/../../b", Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
  });
});

describe("download tokens", () => {
  it("verify, expire and reject tampering", () => {
    const t = signDownloadToken("doc1", "user1", 60);
    expect(verifyDownloadToken(t)).toMatchObject({ id: "doc1", uid: "user1" });
    expect(verifyDownloadToken(t.replace(/.$/, (c) => (c === "a" ? "b" : "a")))).toBeNull();
    expect(verifyDownloadToken(signDownloadToken("doc1", "user1", -5))).toBeNull();
  });
});

describe("upload scanning", () => {
  it("accepts a real PDF, rejects mismatched extension, unsupported types and EICAR", async () => {
    expect((await defaultScanner(Buffer.from("%PDF-1.7 hello"), "a.pdf")).ok).toBe(true);
    expect((await defaultScanner(Buffer.from("%PDF-1.7 hello"), "a.png")).ok).toBe(false);
    expect((await defaultScanner(Buffer.from("MZ..."), "a.exe")).ok).toBe(false);
    const eicar = "%PDF-1.4 X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    expect((await defaultScanner(Buffer.from(eicar), "a.pdf")).ok).toBe(false);
  });
  it("cleans display names", () => {
    expect(cleanFileName("..\\..\\evil/name.pdf")).not.toMatch(/[\\/]/);
  });
});

describe("webhook signature verification (AC-13)", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", status: "paid" });
  const now = 1_800_000_000;
  it("accepts a valid signature inside the replay window", () => {
    expect(verifySignature({ secret, rawBody: body, signatureHeader: signForTest(secret, body, now), now: now + 10 }).ok).toBe(true);
  });
  it("rejects tampered body, wrong secret, stale timestamp and missing header", () => {
    const sig = signForTest(secret, body, now);
    expect(verifySignature({ secret, rawBody: body + " ", signatureHeader: sig, now }).ok).toBe(false);
    expect(verifySignature({ secret: "other", rawBody: body, signatureHeader: sig, now }).ok).toBe(false);
    expect(verifySignature({ secret, rawBody: body, signatureHeader: sig, now: now + 10_000 }).reason).toMatch(/replay/);
    expect(verifySignature({ secret, rawBody: body, signatureHeader: null, now }).ok).toBe(false);
    expect(verifySignature({ secret: "", rawBody: body, signatureHeader: sig, now }).ok).toBe(false);
  });
});
