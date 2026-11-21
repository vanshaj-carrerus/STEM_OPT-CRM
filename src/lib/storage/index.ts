import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { env } from "@/lib/env";
import { hmacHex, safeEqualHex } from "@/lib/crypto/keys";

/**
 * Private document storage. Files are encrypted at rest (AES-256-GCM, per-file derived key) and never served from a
 * public path. Downloads go through a permission-checked route using a short-lived signed token (long spec §11, §14).
 * The adapter interface lets production swap in S3/Azure Blob (with SSE-KMS) without touching callers.
 */
export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

const MAGIC = Buffer.from("CRM1");
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/_\-.]{0,200}$/;

function safePath(key: string): string {
  if (!KEY_RE.test(key) || key.includes("..") || key.includes("//")) throw new Error("Invalid storage key");
  const root = resolve(env().DOCS_DIR);
  const full = resolve(root, key);
  if (!full.startsWith(root + sep)) throw new Error("Invalid storage key");
  return full;
}

function fileKey(salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", env().APP_SECRET, salt, "document-file-key", 32));
}

export class LocalEncryptedStorage implements StorageAdapter {
  async put(key: string, data: Buffer) {
    const path = safePath(key);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", fileKey(salt), iv);
    const enc = Buffer.concat([cipher.update(data), cipher.final()]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), enc]), { flag: "wx" }); // never overwrite
  }
  async get(key: string) {
    const buf = await readFile(safePath(key));
    if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("Corrupt or unsupported stored file");
    const salt = buf.subarray(4, 20);
    const iv = buf.subarray(20, 32);
    const tag = buf.subarray(32, 48);
    const decipher = createDecipheriv("aes-256-gcm", fileKey(salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(48)), decipher.final()]);
  }
}

let adapter: StorageAdapter | null = null;
export function storage(): StorageAdapter {
  return (adapter ??= new LocalEncryptedStorage());
}
/** Test/production override (e.g. S3 adapter). */
export function setStorage(a: StorageAdapter | null) {
  adapter = a;
}

/** Object keys are server-generated: <scope>/<uuid> — never derived from user-supplied file names. */
export function newObjectKey(scope: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(scope)) throw new Error("Invalid scope");
  return `${scope}/${randomUUID()}`;
}

export const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/* --------------------------- signed download tokens --------------------------- */

export interface DownloadClaims {
  /** document/receipt id in the DB */
  id: string;
  /** user the token was minted for — the route re-checks it matches the session user */
  uid: string;
  exp: number; // unix seconds
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

export function signDownloadToken(id: string, uid: string, ttlSec = 60): string {
  const claims: DownloadClaims = { id, uid, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const body = b64(JSON.stringify(claims));
  return `${body}.${hmacHex("download-token", body)}`;
}

export function verifyDownloadToken(token: string): DownloadClaims | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || !/^[0-9a-f]+$/.test(sig) || !safeEqualHex(hmacHex("download-token", body), sig)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DownloadClaims;
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  } catch {
    return null;
  }
}

/* ------------------------------ upload checks ------------------------------ */

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const SIGNATURES: { ext: string[]; mime: string; test: (b: Buffer) => boolean }[] = [
  { ext: ["pdf"], mime: "application/pdf", test: (b) => b.subarray(0, 5).toString() === "%PDF-" },
  { ext: ["png"], mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ["jpg", "jpeg"], mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ["docx", "xlsx"], mime: "application/vnd.openxmlformats-officedocument", test: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { ext: ["doc"], mime: "application/msword", test: (b) => b.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) },
];

export interface ScanResult {
  ok: boolean;
  reason?: string;
  engine: string;
  contentType?: string;
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/**
 * Upload validation + malware-scan hook. Default engine: size, extension↔magic-byte match, EICAR signature.
 * Production: replace via `setScanner()` with ClamAV/commercial scanning (spec §11 "malware scanning").
 */
export type Scanner = (data: Buffer, fileName: string) => Promise<ScanResult>;

export const defaultScanner: Scanner = async (data, fileName) => {
  const engine = "builtin-signature-check";
  if (data.length === 0) return { ok: false, reason: "File is empty.", engine };
  if (data.length > MAX_UPLOAD_BYTES) return { ok: false, reason: "File exceeds the 15 MB limit.", engine };
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const sig = SIGNATURES.find((s) => s.ext.includes(ext));
  if (!sig) return { ok: false, reason: "Unsupported file type (allowed: PDF, PNG, JPG, DOC, DOCX, XLSX).", engine };
  if (!sig.test(data)) return { ok: false, reason: "File contents do not match its extension.", engine };
  if (data.includes(Buffer.from(EICAR))) return { ok: false, reason: "Malware signature detected.", engine };
  return { ok: true, engine, contentType: sig.mime };
};

let scanner: Scanner = defaultScanner;
export const setScanner = (s: Scanner) => {
  scanner = s;
};
export const scanUpload: Scanner = (d, n) => scanner(d, n);

/** Strip path separators / control chars from a user-supplied file name (display only; never used as a path). */
export function cleanFileName(name: string): string {
  return name.replace(/[\\/\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 150) || "file";
}
