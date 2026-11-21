import { NextResponse, type NextRequest } from "next/server";
import { apiError, route } from "@/lib/api";
import { assertCan } from "@/lib/rbac/can";
import { buildComplianceReport } from "@/lib/reports/compliance";
import { audit } from "@/lib/audit";
import { csvEscape } from "@/lib/csv";

export const dynamic = "force-dynamic";

/** GET /api/reports/compliance?report=<key>&format=json|csv — same data and scope as the Reports screen; exports are audited. */
export const GET = route(async (user, req: NextRequest) => {
  assertCan(user, "reports.view");
  const sp = req.nextUrl.searchParams;
  const key = sp.get("report") ?? "lifecycle";
  const format = sp.get("format") === "csv" ? "csv" : "json";
  if (format === "csv") assertCan(user, "reports.export");

  const tables = await buildComplianceReport(user, key);
  if (!tables) return apiError(404, "Report not found or not permitted");

  if (format === "json") return NextResponse.json({ report: key, tables });

  const out: string[] = [];
  for (const t of tables) {
    out.push(csvEscape(t.title));
    out.push(t.columns.map((c) => csvEscape(c.label)).join(","));
    for (const r of t.rows) out.push(t.columns.map((c) => csvEscape(r[c.key])).join(","));
    out.push("");
  }
  await audit({
    actor: user,
    action: "export",
    entityType: "report",
    entityId: key,
    source: "api",
    summary: `Exported report "${key}" (${tables.reduce((n, t) => n + t.rows.length, 0)} rows)`,
  });
  return new NextResponse(out.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="report-${key}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
