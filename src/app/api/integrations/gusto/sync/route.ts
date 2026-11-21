import { NextResponse, type NextRequest } from "next/server";
import { payrollRoute } from "@/lib/payroll/http";
import { runGustoSync } from "@/lib/payroll/sync";

export const dynamic = "force-dynamic";

/**
 * POST /api/integrations/gusto/sync — body { batchId } or { period: {start,end} }. Requires payroll.prepare.
 * With the default manual adapter no network call is made; the call is logged in payroll_sync_logs.
 */
export const POST = payrollRoute(
  async (user, req: NextRequest) => {
    const summary = await runGustoSync(user, await req.json());
    return NextResponse.json(summary);
  },
  { limitPerMin: 20 },
);
