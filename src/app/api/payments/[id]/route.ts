import { NextResponse } from "next/server";
import { paymentRoute } from "@/lib/payments/route";
import { getPaymentDetail } from "@/lib/payments/queries";
import { auditPayment } from "@/lib/payments/core";

export const dynamic = "force-dynamic";

/** GET /api/payments/:id — detail with events, approvals, receipts metadata and linked payments. */
export const GET = paymentRoute(async (user, _req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const detail = await getPaymentDetail(user, id);
  await auditPayment(user, "read", { _id: id, candidateId: detail.payment.candidateId }, "Viewed payment", { source: "api" });
  return NextResponse.json(detail);
});
