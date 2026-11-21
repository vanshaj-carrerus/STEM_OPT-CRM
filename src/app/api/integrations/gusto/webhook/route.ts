import { NextResponse, type NextRequest } from "next/server";
import { handleGustoWebhook } from "@/lib/payroll/webhook-handler";

export const dynamic = "force-dynamic";

/**
 * POST /api/integrations/gusto/webhook — PUBLIC path (no session); authenticity comes from the HMAC signature
 * (header `x-gusto-signature`, optional `x-gusto-timestamp`) with GUSTO_WEBHOOK_SECRET and a 5-minute replay window.
 * Duplicate/retried deliveries get 200 and are never applied twice (AC-13).
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 256_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  try {
    const res = await handleGustoWebhook(raw, {
      signature: req.headers.get("x-gusto-signature") ?? req.headers.get("x-gusto-signature-256"),
      timestamp: req.headers.get("x-gusto-timestamp"),
    });
    return NextResponse.json(res.body, { status: res.status });
  } catch (e) {
    console.error("[gusto webhook]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
