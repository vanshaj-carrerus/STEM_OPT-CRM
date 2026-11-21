import { handlePaymentWebhook } from "@/lib/integrations/payment-webhook";

export const dynamic = "force-dynamic";

/**
 * POST /api/integrations/ria/webhook — PUBLIC path (no session); authenticity comes from the HMAC signature + replay
 * window (RIA_WEBHOOK_SECRET). Ignored with 202 and an audit entry unless Ria automation is approved AND configured.
 * Header contract: `X-Signature: t=<unix>,v1=<hmac-sha256(secret, "<t>.<rawBody>")>`.
 */
export async function POST(req: Request) {
  return handlePaymentWebhook(req, "ria");
}
