import { createHmac, timingSafeEqual } from "node:crypto";
import { connectDb } from "@/lib/db/connect";
import { IntegrationEvent, type Provider, type IIntegrationEvent } from "@/lib/db/models/integration-event";
import { sha256Hex } from "@/lib/storage";

/**
 * Provider webhook plumbing shared by Gusto / Ria / bank adapters (long spec §11; AC-13).
 *  1. verifySignature()  — HMAC-SHA256 over `${timestamp}.${rawBody}` + replay window
 *  2. recordEvent()      — unique (provider,eventId) so duplicate callbacks are no-ops
 *  3. caller applies the state change ONLY when recordEvent says it is new, then markProcessed/markFailed.
 * Never trust browser-submitted completion status; only verified provider events or human reconciliation.
 */
export interface SignatureInput {
  secret: string;
  rawBody: string;
  signatureHeader: string | null; // e.g. "t=1700000000,v1=abcdef..." or a bare hex digest
  timestampHeader?: string | null; // used if signatureHeader is a bare digest
  toleranceSec?: number;
  now?: number; // unix seconds (tests)
}

export function verifySignature(i: SignatureInput): { ok: boolean; reason?: string } {
  if (!i.secret) return { ok: false, reason: "Webhook secret is not configured" };
  if (!i.signatureHeader) return { ok: false, reason: "Missing signature" };
  let ts = i.timestampHeader ?? undefined;
  let sigs: string[] = [];
  if (i.signatureHeader.includes("=")) {
    for (const part of i.signatureHeader.split(",")) {
      const [k, v] = part.split("=");
      if (k.trim() === "t") ts = v.trim();
      if (k.trim() === "v1" || k.trim() === "sha256") sigs.push(v.trim());
    }
  } else sigs = [i.signatureHeader.trim()];
  if (!ts || !/^\d{9,13}$/.test(ts)) return { ok: false, reason: "Missing or invalid timestamp" };
  const tsSec = ts.length > 10 ? Math.floor(Number(ts) / 1000) : Number(ts);
  const now = i.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsSec) > (i.toleranceSec ?? 300)) return { ok: false, reason: "Timestamp outside replay window" };
  const expected = createHmac("sha256", i.secret).update(`${ts}.${i.rawBody}`).digest();
  for (const s of sigs) {
    if (!/^[0-9a-f]{64}$/i.test(s)) continue;
    const got = Buffer.from(s, "hex");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "Signature mismatch" };
}

export interface RecordResult {
  isNew: boolean;
  event: IIntegrationEvent;
}

/** Insert-or-detect-duplicate. `isNew=false` means the caller MUST NOT apply the event again. */
export async function recordEvent(p: { provider: Provider; eventId: string; payload: unknown; idempotencyKey?: string }): Promise<RecordResult> {
  await connectDb();
  const payloadHash = sha256Hex(Buffer.from(typeof p.payload === "string" ? p.payload : JSON.stringify(p.payload)));
  try {
    const doc = await IntegrationEvent.create({
      provider: p.provider,
      eventId: p.eventId,
      idempotencyKey: p.idempotencyKey ?? `${p.provider}:${p.eventId}`,
      payloadHash,
    });
    return { isNew: true, event: doc.toObject() as IIntegrationEvent };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const existing = await IntegrationEvent.findOneAndUpdate(
        { provider: p.provider, eventId: p.eventId },
        { $inc: { attempts: 1 } },
        { returnDocument: "after" },
      ).lean<IIntegrationEvent>();
      return { isNew: false, event: existing! };
    }
    throw err;
  }
}

export async function markProcessed(id: string) {
  await IntegrationEvent.updateOne({ _id: id }, { $set: { status: "processed", processedAt: new Date() } });
}

export async function markFailed(id: string, error: string) {
  await IntegrationEvent.updateOne({ _id: id }, { $set: { status: "failed", error: error.slice(0, 500) }, $inc: { attempts: 1 } });
}

/** Test helper: sign a body the way a provider would. */
export function signForTest(secret: string, rawBody: string, ts: number) {
  return `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")}`;
}
