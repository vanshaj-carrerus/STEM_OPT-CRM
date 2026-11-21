import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GustoBanner } from "@/modules/payroll/sections/gusto-banner";
import { BatchesSection } from "@/modules/payroll/sections/batches-section";
import { MappingSection } from "@/modules/payroll/sections/mapping-section";
import { SyncSection } from "@/modules/payroll/sections/sync-section";
import { FailuresSection } from "@/modules/payroll/sections/failures-section";

export const metadata: Metadata = { title: "Payroll (Gusto)" };

const TABS = [
  { key: "batches", label: "Pay-period batches" },
  { key: "mapping", label: "Candidate mapping" },
  { key: "sync", label: "Gusto sync & logs" },
  { key: "failures", label: "Failures & exceptions" },
] as const;

export default async function PayrollPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("payroll.view");
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "batches";

  return (
    <>
      <PageHeader
        title="Payroll (Gusto)"
        description="Track payroll batches, approvals, provider references and reconciliation. Gusto remains the system of record."
        actions={
          can(user, "payroll.prepare") && (
            <Button asChild>
              <Link href="/payroll/new">
                <Plus className="h-4 w-4" /> New batch
              </Link>
            </Button>
          )
        }
      />
      <GustoBanner />
      <nav className="mb-5 flex gap-1 overflow-x-auto border-b" aria-label="Payroll sections">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/payroll?tab=${t.key}`}
            aria-current={t.key === tab ? "page" : undefined}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium",
              t.key === tab ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "batches" && <BatchesSection user={user} sp={sp} />}
      {tab === "mapping" && <MappingSection user={user} sp={sp} />}
      {tab === "sync" && <SyncSection user={user} />}
      {tab === "failures" && <FailuresSection user={user} />}
    </>
  );
}
