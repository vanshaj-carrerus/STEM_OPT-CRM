import { NextResponse, type NextRequest } from "next/server";
import { pageParams } from "@/lib/api";
import { paymentRoute } from "@/lib/payments/route";
import { paymentInputSchema } from "@/lib/payments/schema";
import { createPayment } from "@/lib/payments/service";
import { listPayments, type PaymentFilters } from "@/lib/payments/queries";
import { toPaymentView } from "@/lib/payments/view";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** GET /api/payments — filtered ledger (record-scoped; destination reference stripped without payments.destination.view). */
export const GET = paymentRoute(async (user, req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pageParams(sp);
  const view = sp.get("view");
  const result = await listPayments(user, {
    candidateId: sp.get("candidateId") || undefined,
    type: sp.get("type") || undefined,
    status: sp.get("status") || undefined,
    currency: sp.get("currency") || undefined,
    from: sp.get("from") || undefined,
    to: sp.get("to") || undefined,
    q: sp.get("q") || undefined,
    view: view === "attention" || view === "approvals" ? (view as PaymentFilters["view"]) : "all",
    page,
    pageSize,
  });
  return NextResponse.json(result);
});

/**
 * POST /api/payments — create a Draft payment. Send an `Idempotency-Key` header so client retries can never create
 * a second ledger row (a replay returns the original payment with 200 instead of 201).
 */
export const POST = paymentRoute(async (user, req: NextRequest) => {
  const body = paymentInputSchema.parse(await req.json());
  const key = req.headers.get("idempotency-key")?.trim().slice(0, 100) || undefined;
  const { payment, replay } = await createPayment(user, body, { requestKey: key });
  const view = toPaymentView(user, payment, { thresholdUsd: await getSetting("payments.highRiskThresholdUsd") });
  return NextResponse.json(view, { status: replay ? 200 : 201 });
});
