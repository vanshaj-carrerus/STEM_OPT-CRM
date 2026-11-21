import { makeSchema, model } from "../base";

export const PROVIDERS = ["gusto", "ria", "bank"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface IIntegrationEvent {
  _id: string;
  provider: Provider;
  eventId: string; // provider's event/transaction-event id
  idempotencyKey: string;
  payloadHash: string;
  status: "received" | "processed" | "failed" | "duplicate_ignored";
  error?: string;
  attempts: number;
  receivedAt: Date;
  processedAt?: Date | null;
  createdAt: Date;
}

const schema = makeSchema<IIntegrationEvent>({
  provider: { type: String, enum: PROVIDERS, required: true },
  eventId: { type: String, required: true },
  idempotencyKey: { type: String, required: true },
  payloadHash: { type: String, required: true },
  status: { type: String, enum: ["received", "processed", "failed", "duplicate_ignored"], default: "received" },
  error: String,
  attempts: { type: Number, default: 0 },
  receivedAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
});
// AC-13: the same provider event can only ever be recorded once.
schema.index({ provider: 1, eventId: 1 }, { unique: true });
schema.index({ idempotencyKey: 1 }, { unique: true });

export const IntegrationEvent = model<IIntegrationEvent>("IntegrationEvent", schema, "integration_events");
