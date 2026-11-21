import { makeSchema, makeAppendOnly, model } from "../base";
import { RECEIPT_KINDS, type ReceiptKind } from "@/lib/payments/evidence";

/** Evidence file metadata. The bytes live encrypted in the storage adapter; rows are immutable. */
export interface IPaymentReceipt {
  _id: string;
  paymentId: string;
  candidateId: string;
  kind: ReceiptKind;
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  scan: { ok: boolean; engine: string };
  note?: string;
  uploadedBy?: string | null; // null = system (verified provider callback)
  createdAt: Date;
}

const schema = makeSchema<IPaymentReceipt>(
  {
    paymentId: { type: String, required: true, index: true },
    candidateId: { type: String, required: true },
    kind: { type: String, enum: RECEIPT_KINDS, required: true },
    objectKey: { type: String, required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    scan: { ok: Boolean, engine: String },
    note: String,
    uploadedBy: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ paymentId: 1, sha256: 1 }, { unique: true });
makeAppendOnly(schema);

export const PaymentReceipt = model<IPaymentReceipt>("PaymentReceipt", schema, "payment_receipts");
