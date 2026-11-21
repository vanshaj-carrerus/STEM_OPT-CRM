import { NextResponse, type NextRequest } from "next/server";
import { payrollRoute } from "@/lib/payroll/http";
import { flagEmergency } from "@/lib/payroll/emergency";
import { listEmergencyItems, getEmergencyItem } from "@/lib/payroll/queries";

export const dynamic = "force-dynamic";

/** GET /api/emergency-payroll?view=active|resolved&q= */
export const GET = payrollRoute(async (user, req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const view = sp.get("view") === "resolved" ? "resolved" : "active";
  return NextResponse.json(await listEmergencyItems(user, { view, q: sp.get("q") || undefined, page: Number(sp.get("page")) || 1 }));
});

/** POST /api/emergency-payroll — flag a candidate for emergency payroll (emergency.manage). */
export const POST = payrollRoute(async (user, req: NextRequest) => {
  const item = await flagEmergency(user, await req.json());
  return NextResponse.json(await getEmergencyItem(user, item._id), { status: 201 });
});
