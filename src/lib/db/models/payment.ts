import { makeSchema, model } from "../base";
import { PAYMENT_STATUSES, PAYMENT_TYPES, type PaymentStatus, type PaymentType } from "@/lib/payments/rules";
import { MONEY_FIELDS } from "@/lib/payments/approvals";

export const PAYMENT_PROVIDERS = ["ria", "bank", "gusto", "manual"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/**
 * One row per payment transaction (the ledger). Money fields are written once at creation / while in Draft and are
 * frozen afterwards (enforced below). Everything that happens later — partial, return, correction, cancellation,
 * reversal — is a linked, append-only row in `payment_events`; nothing is ever deleted.
 */
export interface IPayment {
  _id: string; // Payment ID (UUID, immutable) — also the idempotency key for any automated submission
  candidateId: string;
  type: PaymentType;

  amountMinor: number;
  currency: string;
  feeMinor: number;
  fxRate?: string | null;
  fxQuotedAt?: Date | null;
  convertedAmountMinor?: number | null;
  convertedCurrency?: string | null;
  amountUsdMinor?: number | null;
  /** Net of linked partial/return/correction events (denormalised; events remain the source of truth). */
  adjustmentMinor: number;

  reason: string; // pay period / invoice / purpose
  payPeriodStart?: string | null;
  payPeriodEnd?: string | null;
  invoiceRef?: string | null;

  recipientName?: string | null;
  /** MASKED destination reference only — never a full account/routing/card number. Hidden without payments.destination.view. */
  recipientDestination?: string | null;
  recipientFingerprint?: string | null;
  newRecipient: boolean;
  recipientChanged: boolean;
  beneficiaryMismatch: boolean;
  beneficiaryMismatchNote?: string | null;

  providerName?: PaymentProvider | null;
  providerReference?: string | null; // Ria transfer ID / bank reference / Gusto payroll ID

  status: PaymentStatus;
  highRisk: boolean;
  riskReasons: string[];
  requiredApprovals: number;
  approvalRound: number;

  createdBy: string;
  requestedBy?: string | null;
  requestedAt?: Date | null;
  approvedBy: string[];
  approvedAt?: Date | null;
  submittedBy?: string | null;
  submittedAt?: Date | null;
  paidAt?: Date | null;
  paidVia?: "manual_evidence" | "provider_callback" | null;
  failedAt?: Date | null;
  cancelledAt?: Date | null;
  reversedAt?: Date | null;
  exceptionReason?: string | null;
  reconciledBy?: string | null;
  reconciledAt?: Date | null;
  reconciliation?: { statementRef: string; settledAmountMinor: number; statementDate?: string | null; note?: string | null } | null;

  linkedPaymentId?: string | null; // adjustment / remainder / correction points at the original
  retryOf?: string | null; // replacement for a failed/cancelled payment

  requestKey?: string | null; // client Idempotency-Key (per creator)
  createdAt: Date;
  updatedAt: Date;
}

const schema = makeSchema<IPayment>({
  candidateId: { type: String, required: true, index: true },
  type: { type: String, enum: PAYMENT_TYPES, required: true },

  amountMinor: { type: Number, required: true, validate: { validator: (v: number) => Number.isSafeInteger(v) && v > 0, message: "amountMinor must be a positive integer" } },
  currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
  feeMinor: { type: Number, default: 0, validate: { validator: (v: number) => Number.isSafeInteger(v) && v >= 0, message: "feeMinor must be a non-negative integer" } },
  fxRate: { type: String, default: null },
  fxQuotedAt: { type: Date, default: null },
  convertedAmountMinor: { type: Number, default: null },
  convertedCurrency: { type: String, default: null },
  amountUsdMinor: { type: Number, default: null },
  adjustmentMinor: { type: Number, default: 0 },

  reason: { type: String, required: true },
  payPeriodStart: { type: String, default: null },
  payPeriodEnd: { type: String, default: null },
  invoiceRef: { type: String, default: null },

  recipientName: { type: String, default: null },
  recipientDestination: { type: String, default: null },
  recipientFingerprint: { type: String, default: null },
  newRecipient: { type: Boolean, default: false },
  recipientChanged: { type: Boolean, default: false },
  beneficiaryMismatch: { type: Boolean, default: false },
  beneficiaryMismatchNote: { type: String, default: null },

  providerName: { type: String, enum: [...PAYMENT_PROVIDERS, null], default: null },
  providerReference: { type: String, default: null },

  status: { type: String, enum: PAYMENT_STATUSES, default: "draft", index: true },
  highRisk: { type: Boolean, default: false },
  riskReasons: { type: [String], default: [] },
  requiredApprovals: { type: Number, default: 1 },
  approvalRound: { type: Number, default: 0 },

  createdBy: { type: String, required: true },
  requestedBy: { type: String, default: null },
  requestedAt: { type: Date, default: null },
  approvedBy: { type: [String], default: [] },
  approvedAt: { type: Date, default: null },
  submittedBy: { type: String, default: null },
  submittedAt: { type: Date, default: null },
  paidAt: { type: Date, default: null },
  paidVia: { type: String, enum: ["manual_evidence", "provider_callback", null], default: null },
  failedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  reversedAt: { type: Date, default: null },
  exceptionReason: { type: String, default: null },
  reconciledBy: { type: String, default: null },
  reconciledAt: { type: Date, default: null },
  reconciliation: {
    type: { _id: false, statementRef: String, settledAmountMinor: Number, statementDate: String, note: String },
    default: null,
  },

  linkedPaymentId: { type: String, default: null, index: true },
  retryOf: { type: String, default: null },
  requestKey: { type: String, default: null },
});

schema.index({ candidateId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ currency: 1, status: 1 });
// the same Ria transfer ID / bank reference can never be recorded against two payments (duplicate-transfer guard)
schema.index({ providerName: 1, providerReference: 1 }, { unique: true, partialFilterExpression: { providerReference: { $type: "string" } } });
// client retries of POST /api/payments with the same Idempotency-Key never create a second ledger row
schema.index({ createdBy: 1, requestKey: 1 }, { unique: true, partialFilterExpression: { requestKey: { $type: "string" } } });

const MONEY = new Set<string>(MONEY_FIELDS);

function touchedKeys(update: unknown): string[] {
  if (!update || typeof update !== "object") return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(update as Record<string, unknown>)) {
    if (k.startsWith("$")) {
      if (v && typeof v === "object") keys.push(...Object.keys(v as Record<string, unknown>));
    } else keys.push(k);
  }
  return keys;
}

type QueryLike = { getUpdate(): unknown; getFilter(): Record<string, unknown> };

const guardUpdate = function (this: unknown) {
  const q = this as QueryLike;
  const update = q.getUpdate();
  if (Array.isArray(update)) throw new Error("Pipeline updates are not permitted on payments.");
  const hit = touchedKeys(update).filter((k) => MONEY.has(k));
  if (hit.length && q.getFilter().status !== "draft") {
    throw new Error(`Payment money fields are frozen once a payment leaves Draft (${hit.join(", ")}). Cancel it and create a new linked payment.`);
  }
};

const forbid = function () {
  throw new Error("Payments are never deleted or replaced; record a linked cancellation/reversal event instead.");
};

for (const op of ["updateOne", "updateMany", "findOneAndUpdate"] as const) schema.pre(op as never, guardUpdate as never);
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete", "findOneAndReplace", "replaceOne"] as const) schema.pre(op as never, forbid as never);
schema.pre("deleteOne", { document: true, query: false }, forbid as never);
schema.pre("save", function () {
  if (this.isNew) return;
  const changed = this.modifiedPaths().filter((p) => MONEY.has(p));
  if (changed.length && (this as unknown as { status: string }).status !== "draft") {
    throw new Error(`Payment money fields are frozen once a payment leaves Draft (${changed.join(", ")}).`);
  }
});

export const Payment = model<IPayment>("Payment", schema, "payments");
