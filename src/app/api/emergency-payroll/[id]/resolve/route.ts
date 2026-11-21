import { NextResponse, type NextRequest } from "next/server";
import { payrollRoute } from "@/lib/payroll/http";
import { resolveEmergency } from "@/lib/payroll/emergency";
import { getEmergencyItem } from "@/lib/payroll/queries";
import { PayrollError } from "@/lib/payroll/errors";
import { apiError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/emergency-payroll/{id}/resolve — requires emergency.resolve. Resolves ONLY when payroll is Processed AND
 * reconciled (and a reviewer confirms — the caller is that reviewer) or an approved exception exists; otherwise 409
 * with the reason from canResolveEmergency (AC-09 / AC-10).
 */
export const POST = payrollRoute(async (user, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { note?: string };
  try {
    await resolveEmergency(user, id, { note: typeof body.note === "string" ? body.note : undefined });
  } catch (e) {
    if (e instanceof PayrollError && e.code === "not_resolvable") return apiError(409, e.message, { code: e.code });
    throw e;
  }
  return NextResponse.json(await getEmergencyItem(user, id));
});
