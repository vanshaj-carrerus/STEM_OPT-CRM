import { NextResponse, type NextRequest } from "next/server";
import { paymentRoute } from "@/lib/payments/route";
import { exportPayments, type PaymentFilters } from "@/lib/payments/queries";
import { buildLedgerCsv } from "@/lib/payments/ledger-csv";
import { audit } from "@/lib/audit";
import { assertCan, can, ForbiddenError } from "@/lib/rbac/can";

export const dynamic = "force-dynamic";

/** GET /api/payments/export — audited CSV of the filtered ledger. Destination column only for payments.destination.view. */
export const GET = paymentRoute(async (user, req: NextRequest) => {
  assertCan(user, "payments.view");
  if (!can(user, "reports.export") && !can(user, "payments.reconcile")) throw new ForbiddenError("You do not have permission to export payments.");
  const sp = req.nextUrl.searchParams;
  const view = sp.get("view");
  const filters: PaymentFilters = {
    candidateId: sp.get("candidateId") || undefined,
    type: sp.get("type") || undefined,
    status: sp.get("status") || undefined,
    currency: sp.get("currency") || undefined,
    from: sp.get("from") || undefined,
    to: sp.get("to") || undefined,
    q: sp.get("q") || undefined,
    view: view === "attention" ? "attention" : "all",
  };
  const rows = await exportPayments(user, filters);
  const csv = buildLedgerCsv(rows, { includeDestination: can(user, "payments.destination.view") });
  await audit({ actor: user, action: "export", entityType: "payment", summary: `Exported ${rows.length} payments to CSV`, after: { filters, count: rows.length }, source: "api" });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payments-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
