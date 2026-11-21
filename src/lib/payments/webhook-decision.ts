import { z } from "zod";
import { canTransitionPayment, type PaymentStatus } from "./rules";

/**
 * Pure decision logic for provider (Ria / bank) callbacks (AC-13). A callback can only ever propose a status; whether
 * it is applied is decided against the ledger state machine. Duplicate delivery is handled upstream by
 * `recordEvent` (unique provider+eventId); this layer additionally makes re-application a harmless no-op.
 */

/** Statuses a provider callback is allowed to drive. Approval, submission and reconciliation are human steps. */
export const WEBHOOK_TARGETS: readonly PaymentStatus[] = ["processing", "paid", "failed", "cancelled", "reversed"];

const STATUS_MAP: Record<string, PaymentStatus> = {
  pending: "processing",
  in_progress: "processing",
  inprogress: "processing",
  processing: "processing",
  sent: "processing",
  accepted: "processing",
  paid: "paid",
  completed: "paid",
  complete: "paid",
  delivered: "paid",
  settled: "paid",
  failed: "failed",
  rejected: "failed",
  declined: "failed",
  error: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
  returned: "reversed",
  reversed: "reversed",
  refunded: "reversed",
};

export function mapProviderStatus(raw: string): PaymentStatus | null {
  return STATUS_MAP[raw.trim().toLowerCase().replace(/[\s-]+/g, "_")] ?? null;
}

export type WebhookDecision =
  | { action: "apply"; to: PaymentStatus }
  | { action: "noop"; reason: string }
  | { action: "ignore"; reason: string };

export function decideWebhookTransition(current: PaymentStatus, rawStatus: string, opts: { hasProviderReference: boolean }): WebhookDecision {
  const target = mapProviderStatus(rawStatus);
  if (!target) return { action: "ignore", reason: `Unrecognised provider status "${rawStatus.slice(0, 40)}"` };
  if (!WEBHOOK_TARGETS.includes(target)) return { action: "ignore", reason: `A provider callback cannot set status ${target}` };
  if (target === current) return { action: "noop", reason: `Payment is already ${current}` };
  if (target === "paid" && !opts.hasProviderReference) {
    return { action: "ignore", reason: "A Paid callback without a provider reference is not accepted" };
  }
  if (!canTransitionPayment(current, target)) return { action: "ignore", reason: `Illegal transition ${current} → ${target}; kept for human review` };
  return { action: "apply", to: target };
}

/** Our webhook contract (documented for the provider integration; secrets/accounts never travel in it). */
export const providerEventSchema = z.object({
  eventId: z.string().min(4).max(120),
  /** Our payment UUID, sent as the idempotency key when the transfer was created. */
  idempotencyKey: z.string().min(8).max(80).optional(),
  /** Ria transfer ID / bank reference. */
  transferId: z.string().min(4).max(64).optional(),
  status: z.string().min(2).max(40),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  currency: z.string().length(3).optional(),
  beneficiaryName: z.string().max(120).optional(),
  failureReason: z.string().max(300).optional(),
});
export type ProviderEvent = z.infer<typeof providerEventSchema>;
