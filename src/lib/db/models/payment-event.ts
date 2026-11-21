import { makeSchema, makeAppendOnly, model } from "../base";
import { PAYMENT_STATUSES, type PaymentStatus } from "@/lib/payments/rules";

export const PAYMENT_EVENT_KINDS = [
  "created",
  "edited",
  "approval_requested",
  "approved",
  "rejected",
  "status_change",
  "partial",
  "return",
  "correction",
  "cancellation",
  "reversal",
  "receipt",
  "reconciled",
  "flag",
  "note",
  "webhook",
] as const;
export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number];

/**
 * Append-only timeline of everything that happens to a payment. Partial payments, returns, corrections,
 * cancellations and reversals live here as LINKED events (never edits to the original row).
 * Never carries the destination reference — viewers without payments.destination.view can read it.
 */
export interface IPaymentEvent {
  _id: string;
  paymentId: string;
  candidateId: string;
  kind: PaymentEventKind;
  actorId?: string | null;
  actorType: "user" | "webhook" | "system";
  fromStatus?: PaymentStatus | null;
  toStatus?: PaymentStatus | null;
  reason?: string;
  /** Signed delta to the net amount for partial / return / correction events. */
  amountDeltaMinor: number;
  currency?: string;
  linkedPaymentId?: string | null;
  providerEventId?: string | null;
  meta?: Record<string, unknown>;
  createdAt: Date;
}

const schema = makeSchema<IPaymentEvent>(
  {
    paymentId: { type: String, required: true, index: true },
    candidateId: { type: String, required: true, index: true },
    kind: { type: String, enum: PAYMENT_EVENT_KINDS, required: true },
    actorId: { type: String, default: null },
    actorType: { type: String, enum: ["user", "webhook", "system"], default: "user" },
    fromStatus: { type: String, enum: [...PAYMENT_STATUSES, null], default: null },
    toStatus: { type: String, enum: [...PAYMENT_STATUSES, null], default: null },
    reason: String,
    amountDeltaMinor: { type: Number, default: 0 },
    currency: String,
    linkedPaymentId: { type: String, default: null },
    providerEventId: { type: String, default: null },
    meta: { type: Object },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);
schema.index({ paymentId: 1, createdAt: 1 });
// a provider event can be attached to a payment's timeline at most once
schema.index({ paymentId: 1, providerEventId: 1 }, { unique: true, partialFilterExpression: { providerEventId: { $type: "string" } } });
makeAppendOnly(schema);

export const PaymentEvent = model<IPaymentEvent>("PaymentEvent", schema, "payment_events");
