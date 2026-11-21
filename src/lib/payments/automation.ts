import { getSetting } from "@/lib/settings";
import { riaAutomationAllowed } from "./rules";
import { getRiaAdapter, RiaAutomationDisabledError } from "@/lib/integrations/ria/adapter";
import type { SessionUser } from "@/lib/auth/session";
import { assertCan } from "@/lib/rbac/can";
import { PaymentError } from "./errors";
import { loadPaymentFor } from "./core";
import { recordSubmission } from "./execution";

export const RIA_DISABLED_BANNER =
  "Ria automated transfers are disabled until Ria's business-use approval and API access are confirmed; using manual reference tracking.";

/** Settings-driven switch (Admin → Integrations → Ria). */
export async function riaAutomationEnabled(): Promise<boolean> {
  const s = await getSetting("integrations.ria");
  return riaAutomationAllowed({ riaContractApproved: s.contractApproved, riaApiConfigured: s.apiConfigured });
}

/**
 * Future automated submission. Refuses unless Ria automation is approved AND configured. The payment's UUID is the
 * idempotency key, so a retried call can never create a second transfer; the returned transfer ID is recorded
 * through the same `recordSubmission` path (unique provider reference) as the manual workflow.
 */
export async function submitViaRia(actor: SessionUser, paymentId: string) {
  assertCan(actor, "payments.submit");
  if (!(await riaAutomationEnabled())) throw new RiaAutomationDisabledError();
  const p = await loadPaymentFor(actor, paymentId);
  if (p.type !== "ria_transfer") throw new PaymentError("Only Ria transfers can be submitted through Ria.", 422, "validation");
  if (p.status !== "approved") throw new PaymentError("Only an Approved payment can be submitted.", 409, "illegal_transition");
  const s = await getSetting("integrations.ria");
  const adapter = getRiaAdapter({ riaContractApproved: s.contractApproved, riaApiConfigured: s.apiConfigured });
  if (adapter.mode !== "api") throw new RiaAutomationDisabledError();
  const res = await adapter.submitTransfer({
    idempotencyKey: p._id,
    sendAmountMinor: p.amountMinor,
    sendCurrency: p.currency,
    receiveCurrency: p.convertedCurrency ?? undefined,
    beneficiaryName: p.recipientName ?? "",
    destinationRef: p.recipientDestination ?? undefined,
  });
  return recordSubmission(actor, paymentId, { providerReference: res.transferId, note: "Submitted via Ria API (idempotent by payment ID)" });
}
