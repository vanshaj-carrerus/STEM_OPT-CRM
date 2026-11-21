import { handlePaymentWebhook } from "@/lib/integrations/payment-webhook";

export const dynamic = "force-dynamic";

/** POST /api/integrations/bank/webhook — same defensive handling as Ria; disabled unless integrations.bank.route = "api". */
export async function POST(req: Request) {
  return handlePaymentWebhook(req, "bank");
}
