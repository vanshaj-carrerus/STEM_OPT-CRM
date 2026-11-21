import { NextResponse, type NextRequest } from "next/server";
import { pageParams } from "@/lib/api";
import { assertCan } from "@/lib/rbac/can";
import { payrollRoute } from "@/lib/payroll/http";
import { createBatch } from "@/lib/payroll/batches";
import { listBatches } from "@/lib/payroll/queries";
import { batchView } from "@/lib/payroll/serialize";

export const dynamic = "force-dynamic";

/** GET /api/payroll/batches — list (amounts/totals stripped without payroll.amounts.view). */
export const GET = payrollRoute(async (user, req: NextRequest) => {
  assertCan(user, "payroll.view");
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pageParams(sp);
  const result = await listBatches(user, {
    status: sp.get("status") || undefined,
    reconciliation: sp.get("reconciliation") || undefined,
    from: sp.get("from") || undefined,
    to: sp.get("to") || undefined,
    page,
    pageSize,
  });
  return NextResponse.json(result);
});

/** POST /api/payroll/batches — create a draft batch for a pay period. Requires payroll.prepare. */
export const POST = payrollRoute(async (user, req: NextRequest) => {
  const body = await req.json();
  const created = await createBatch(user, body);
  return NextResponse.json(batchView(user, created), { status: 201 });
});
