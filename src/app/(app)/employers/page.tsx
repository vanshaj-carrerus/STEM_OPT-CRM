import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { listEmployers } from "@/lib/employers/service";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";

export const metadata: Metadata = { title: "Employers" };

export default async function EmployersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const user = await requirePage("candidates.view");
  const sp = await searchParams;
  const { rows, total, page, pageSize } = await listEmployers(user, { q: sp.q, page: Number(sp.page) || 1, pageSize: 25 });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => `/employers?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), page: String(p) })}`;

  return (
    <>
      <PageHeader
        title="Employers"
        description="Employers and client sites used for CPT segments, OPT / STEM OPT employment and E-Verify details."
        actions={
          can(user, "immigration.edit") ? (
            <Button asChild>
              <Link href="/employers/new">
                <Plus className="h-4 w-4" /> New employer
              </Link>
            </Button>
          ) : undefined
        }
      />
      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 border-b p-4">
          <Input name="q" defaultValue={sp.q ?? ""} placeholder="Search legal name…" className="w-72" />
          <Button type="submit" variant="secondary">
            Search
          </Button>
          <Button asChild variant="ghost">
            <Link href="/employers">Reset</Link>
          </Button>
        </form>
        {rows.length === 0 ? (
          <EmptyState title="No employers found" description="Add an employer before recording CPT segments or employment." />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>Legal name</TH>
                  <TH>Location</TH>
                  <TH>Contacts</TH>
                  <TH>Type</TH>
                  <TH>E-Verify</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((e) => (
                  <TR key={e.id}>
                    <TD>
                      <Link href={`/employers/${e.id}`} className="font-medium text-primary hover:underline">
                        {e.legalName}
                      </Link>
                    </TD>
                    <TD>{[e.address?.city, e.address?.state].filter(Boolean).join(", ") || <span className="text-muted-foreground">—</span>}</TD>
                    <TD>{e.contacts.length}</TD>
                    <TD>{e.isClientSite ? <Badge tone="info">Client site</Badge> : <Badge tone="neutral">Direct</Badge>}</TD>
                    <TD>{e.hasEverify ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Missing</Badge>}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
          <span>
            {total} employer{total === 1 ? "" : "s"} · page {page} of {pages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={href(page - 1)}>Previous</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild variant="outline" size="sm">
                <Link href={href(page + 1)}>Next</Link>
              </Button>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}
