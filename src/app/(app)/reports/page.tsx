import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { availableComplianceReports, buildComplianceReport } from "@/lib/reports/compliance";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ report?: string }> }) {
  const user = await requirePage("reports.view");
  const sp = await searchParams;
  const reports = availableComplianceReports(user);
  const key = reports.find((r) => r.key === sp.report)?.key ?? reports[0]?.key;
  const tables = key ? await buildComplianceReport(user, key) : null;

  return (
    <>
      <PageHeader
        title="Reports"
        description="Compliance reports scoped to the candidates you can access. Exports are audit-logged."
        actions={
          key &&
          can(user, "reports.export") && (
            <Button asChild variant="outline">
              <a href={`/api/reports/compliance?report=${key}&format=csv`}>
                <Download className="h-4 w-4" /> Export CSV
              </a>
            </Button>
          )
        }
      />

      <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Reports" className="space-y-1">
          {reports.map((r) => (
            <Link
              key={r.key}
              href={`/reports?report=${r.key}`}
              aria-current={r.key === key ? "page" : undefined}
              className={cn("block rounded-md px-3 py-2 text-sm", r.key === key ? "bg-secondary font-medium text-secondary-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              {r.label}
            </Link>
          ))}
          <p className="px-3 pt-3 text-xs text-muted-foreground">Payroll, payment and document reports appear here as those modules go live.</p>
        </nav>

        <div className="space-y-5">
          {!tables && <EmptyState title="No reports available for your role" />}
          {tables?.map((t) => (
            <Card key={t.key}>
              <CardHeader title={t.title} description={t.description} />
              {t.rows.length === 0 ? (
                <EmptyState title="Nothing to show" description="No records match this report for your access scope." />
              ) : (
                <TableWrap>
                  <Table>
                    <THead>
                      <tr>
                        {t.columns.map((c) => (
                          <TH key={c.key}>{c.label}</TH>
                        ))}
                      </tr>
                    </THead>
                    <tbody>
                      {t.rows.map((r, i) => (
                        <TR key={i}>
                          {t.columns.map((c) => (
                            <TD key={c.key}>{r[c.key]}</TD>
                          ))}
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                </TableWrap>
              )}
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
