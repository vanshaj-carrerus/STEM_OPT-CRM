import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/auth/ratelimit";
import { getSetting } from "@/lib/settings";
import { markFailed, markProcessed, recordEvent, verifySignature } from "@/lib/integrations/events";
import { providerEventSchema } from "@/lib/payments/webhook-decision";
import { applyProviderEvent } from "@/lib/payments/provider-events";
import { riaAutomationAllowed } from "@/lib/payments/rules";
import { sha256Hex } from "@/lib/storage";

type PaymentProvider = "ria" | "bank";

async function enabled(provider: PaymentProvider): Promise<boolean> {
  if (provider === "ria") {
    const s = await getSetting("integrations.ria");
    return riaAutomationAllowed({ riaContractApproved: s.contractApproved, riaApiConfigured: s.apiConfigured });
  }
  return (await getSetting("integrations.bank")).route === "api";
}

/**
 * Shared, defensive handler for provider callbacks (AC-13).
 *   disabled (no contract approval / API not configured) → audit + 202, nothing is applied
 *   bad / stale signature                                 → 401
 *   duplicate or retried delivery                         → 200, no second change (unique provider+eventId)
 *   previously failed processing                          → re-applied idempotently (provider retry)
 *   processing error                                      → event marked failed, 500 so the provider retries
 * The raw body is read once and verified BEFORE it is parsed.
 */
export async function handlePaymentWebhook(req: Request, provider: PaymentProvider): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await rateLimit(`webhook:${provider}:${ip}`, 120, 60);
  if (!rl.allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const rawBody = await req.text();
  if (rawBody.length > 64_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

  if (!(await enabled(provider))) {
    await audit({
      action: "webhook", entityType: "payment_webhook", source: "webhook",
      summary: `${provider} callback received while ${provider} automation is disabled; ignored`,
      after: { provider, bodySha256: sha256Hex(Buffer.from(rawBody)), bytes: rawBody.length },
    });
    return NextResponse.json({ status: "ignored", reason: "automation disabled" }, { status: 202 });
  }

  const secret = provider === "ria" ? env().RIA_WEBHOOK_SECRET : env().BANK_WEBHOOK_SECRET;
  const sig = verifySignature({
    secret: secret ?? "",
    rawBody,
    signatureHeader: req.headers.get("x-signature") ?? req.headers.get("x-webhook-signature"),
    timestampHeader: req.headers.get("x-timestamp"),
  });
  if (!sig.ok) {
    await audit({ action: "webhook", entityType: "payment_webhook", source: "webhook", summary: `${provider} callback rejected: ${sig.reason}`, after: { provider } });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = providerEventSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "Invalid event", details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
  const ev = parsed.data;

  const rec = await recordEvent({ provider, eventId: ev.eventId, payload: rawBody });
  if (!rec.isNew && rec.event.status !== "failed") {
    return NextResponse.json({ status: "duplicate", eventId: ev.eventId }, { status: 200 }); // retried delivery: nothing changes
  }

  try {
    const result = await applyProviderEvent(provider, ev, rawBody);
    if (result.outcome === "unknown_payment") {
      // possibly arrived before the operator recorded the reference: keep it retryable
      await markFailed(rec.event._id, "No matching payment yet");
      return NextResponse.json({ status: "pending", reason: "no matching payment" }, { status: 202 });
    }
    await markProcessed(rec.event._id);
    return NextResponse.json({ status: "ok", outcome: result.outcome }, { status: 200 });
  } catch (err) {
    await markFailed(rec.event._id, (err as Error).message ?? "processing error");
    console.error(`[${provider} webhook]`, err);
    return NextResponse.json({ error: "Processing failed; retry later" }, { status: 500 });
  }
}
