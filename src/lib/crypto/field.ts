import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deriveKey } from "./keys";

/**
 * Field-level AES-256-GCM encryption for sensitive identifiers (SEVIS ID, EAD number, EIN,
 * E-Verify ID, date of birth, payment destination). Stored as "v1:<iv>:<tag>:<ciphertext>" (base64url).
 */
const PREFIX = "v1";

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey("field-encryption"), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(":");
}

export function decryptField(payload: string): string {
  const [v, iv, tag, data] = payload.split(":");
  if (v !== PREFIX || !iv || !tag || !data) throw new Error("Unsupported encrypted field format");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey("field-encryption"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Display-safe mask: keeps only the last `visible` characters (default 4). */
export function maskValue(value: string | null | undefined, visible = 4): string {
  if (!value) return "";
  const v = value.trim();
  if (v.length <= visible) return "•".repeat(v.length);
  return "•".repeat(Math.max(4, v.length - visible)) + v.slice(-visible);
}

/** Shape stored in Mongo for a protected field: ciphertext + safe mask. Plaintext is never persisted. */
export interface ProtectedField {
  enc: string;
  mask: string;
}

export function protectField(plain: string | null | undefined): ProtectedField | undefined {
  if (!plain || !plain.trim()) return undefined;
  return { enc: encryptField(plain.trim()), mask: maskValue(plain) };
}

export function revealField(f: ProtectedField | null | undefined): string | undefined {
  return f?.enc ? decryptField(f.enc) : undefined;
}
