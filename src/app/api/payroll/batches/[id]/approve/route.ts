import { NextResponse, type NextRequest } from "next/server";
import { payrollRoute } from "@/lib/payroll/http";
import { approveBatch } from "@/lib/payroll/batches";
import { batchView } from "@/lib/payroll/serialize";

export const dynamic = "force-dynamic";

/**
 * POST /api/payroll/batches/{id}/approve — final approval. Requires payroll.approve and enforces separation of duties:
 * the preparer and anyone who edited the batch get 403 (code separation_of_duties). AC-11.
 */
export const POST = payrollRoute(async (user, _req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const batch = await approveBatch(user, id);
  return NextResponse.json(batchView(user, batch));
});
