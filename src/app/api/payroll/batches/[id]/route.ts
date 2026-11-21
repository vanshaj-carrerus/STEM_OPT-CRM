import { NextResponse, type NextRequest } from "next/server";
import { payrollRoute } from "@/lib/payroll/http";
import { getBatchDetail } from "@/lib/payroll/queries";

export const dynamic = "force-dynamic";

/** GET /api/payroll/batches/{id} — batch with items; amounts stripped server-side without payroll.amounts.view. */
export const GET = payrollRoute(async (user, _req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { logs: _logs, ...detail } = await getBatchDetail(user, id);
  void _logs;
  return NextResponse.json(detail);
});
