import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { paymentRoute } from "@/lib/payments/route";
import { approvePayment } from "@/lib/payments/service";
import { toPaymentView } from "@/lib/payments/view";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

const body = z.object({ note: z.string().trim().max(500).optional() });

/**
 * POST /api/payments/:id/approve — dual-control rules are enforced in the service:
 * the requester/creator can never approve (403 separation_of_duties); high-risk payments need two distinct approvers.
 */
export const POST = paymentRoute(async (user, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { note } = body.parse(await req.json().catch(() => ({})));
  const r = await approvePayment(user, id, note);
  return NextResponse.json({
    finalized: r.finalized,
    approvals: r.progress.count,
    required: r.progress.required,
    payment: toPaymentView(user, r.payment, { thresholdUsd: await getSetting("payments.highRiskThresholdUsd") }),
  });
});
