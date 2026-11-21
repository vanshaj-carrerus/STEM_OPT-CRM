import { connectDb } from "@/lib/db/connect";
import { PaymentReceipt, type IPaymentReceipt } from "@/lib/db/models/payment-receipt";
import type { SessionUser } from "@/lib/auth/session";
import { can, ForbiddenError, assertCan } from "@/lib/rbac/can";
import { audit } from "@/lib/audit";
import { cleanFileName, newObjectKey, scanUpload, sha256Hex, signDownloadToken, storage, verifyDownloadToken } from "@/lib/storage";
import { RECEIPT_KINDS, type ReceiptKind } from "./evidence";
import { PaymentError, PaymentNotFoundError } from "./errors";
import { appendPaymentEvent, loadPaymentFor } from "./core";
import { isDuplicateKey } from "./service";

const TOKEN_PREFIX = "payment_receipt:";

/** Encrypted evidence upload (receipt, remittance advice, bank confirmation). Append-only, scanned, audited. */
export async function addReceipt(actor: SessionUser, paymentId: string, input: { data: Buffer; fileName: string; kind: string; note?: string }) {
  if (!can(actor, "payments.prepare") && !can(actor, "payments.submit") && !can(actor, "payments.reconcile")) throw new ForbiddenError();
  if (!(RECEIPT_KINDS as readonly string[]).includes(input.kind)) throw new PaymentError("Unknown evidence type.", 422, "validation", { kind: "Choose an evidence type" });
  const p = await loadPaymentFor(actor, paymentId);
  if (p.status === "cancelled") throw new PaymentError("Evidence cannot be added to a cancelled payment.", 409, "illegal_state");

  const fileName = cleanFileName(input.fileName);
  const scan = await scanUpload(input.data, fileName);
  if (!scan.ok) throw new PaymentError(scan.reason ?? "File rejected by upload checks.", 422, "scan_failed", { file: scan.reason ?? "Rejected" });

  const sha256 = sha256Hex(input.data);
  const objectKey = newObjectKey("payment-receipts");
  await storage().put(objectKey, input.data);
  await connectDb();
  try {
    const doc = await PaymentReceipt.create({
      paymentId, candidateId: p.candidateId, kind: input.kind as ReceiptKind, objectKey, fileName,
      contentType: scan.contentType ?? "application/octet-stream", sizeBytes: input.data.length, sha256,
      scan: { ok: scan.ok, engine: scan.engine }, note: input.note?.slice(0, 300), uploadedBy: actor.id,
    });
    const receipt = doc.toObject() as IPaymentReceipt;
    await appendPaymentEvent({ paymentId, candidateId: p.candidateId, kind: "receipt", actorId: actor.id, reason: `${input.kind}: ${fileName}`, meta: { receiptId: receipt._id, kind: input.kind, sha256 } });
    await audit({ actor, action: "create", entityType: "payment_receipt", entityId: receipt._id, candidateId: p.candidateId, summary: `Uploaded ${input.kind} for payment ${paymentId}`, after: { paymentId, kind: input.kind, fileName, sha256, sizeBytes: input.data.length } });
    return receipt;
  } catch (err) {
    if (isDuplicateKey(err)) throw new PaymentError("This exact file is already attached to the payment.", 409, "duplicate_file");
    throw err;
  }
}

/** System-stored evidence for a verified provider/bank callback (the signed payload itself is the evidence). */
export async function addCallbackEvidence(p: { _id: string; candidateId: string }, rawBody: string, engine: string) {
  const data = Buffer.from(rawBody, "utf8");
  const sha256 = sha256Hex(data);
  const objectKey = newObjectKey("payment-receipts");
  await storage().put(objectKey, data);
  await connectDb();
  try {
    const doc = await PaymentReceipt.create({
      paymentId: p._id, candidateId: p.candidateId, kind: "provider_callback", objectKey,
      fileName: `${engine}-callback-${sha256.slice(0, 12)}.json`, contentType: "application/json", sizeBytes: data.length, sha256,
      scan: { ok: true, engine: "system-generated" }, uploadedBy: null,
    });
    return doc.toObject() as IPaymentReceipt;
  } catch (err) {
    if (isDuplicateKey(err)) return PaymentReceipt.findOne({ paymentId: p._id, sha256 }).lean<IPaymentReceipt>();
    throw err;
  }
}

export async function listReceipts(actor: SessionUser, paymentId: string) {
  await loadPaymentFor(actor, paymentId);
  return PaymentReceipt.find({ paymentId }).sort({ createdAt: 1 }).lean<IPaymentReceipt[]>();
}

/** Permission-checked: mints a 60-second token bound to the requesting user. Audited at download time. */
export async function mintReceiptDownload(actor: SessionUser, receiptId: string): Promise<{ url: string; expiresInSec: number }> {
  assertCan(actor, "payments.view");
  await connectDb();
  const r = await PaymentReceipt.findById(receiptId).lean<IPaymentReceipt>();
  if (!r) throw new PaymentNotFoundError();
  await loadPaymentFor(actor, r.paymentId); // permission + candidate scope
  const token = signDownloadToken(TOKEN_PREFIX + receiptId, actor.id, 60);
  return { url: `/api/payments/receipts/download?token=${encodeURIComponent(token)}`, expiresInSec: 60 };
}

/** Verifies the token, re-checks access and returns the decrypted bytes. The route audits the download. */
export async function readReceiptByToken(actor: SessionUser, token: string) {
  const claims = verifyDownloadToken(token);
  if (!claims || !claims.id.startsWith(TOKEN_PREFIX) || claims.uid !== actor.id) throw new ForbiddenError("This download link is invalid or has expired.");
  const receiptId = claims.id.slice(TOKEN_PREFIX.length);
  assertCan(actor, "payments.view");
  await connectDb();
  const r = await PaymentReceipt.findById(receiptId).lean<IPaymentReceipt>();
  if (!r) throw new PaymentNotFoundError();
  await loadPaymentFor(actor, r.paymentId);
  const data = await storage().get(r.objectKey);
  return { receipt: r, data };
}
