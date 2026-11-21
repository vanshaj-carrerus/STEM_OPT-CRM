import type { Metadata } from "next";
import Link from "next/link";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { audit } from "@/lib/audit";
import { formatDate } from "@/lib/compliance/dates";
import { QUEUE_FILTERS, type QueueFilter } from "@/lib/documents/schema";
import { listDocumentQueue } from "@/lib/documents/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { DocStatusBadge } from "@/modules/documents/status-badge";

export const metadata: Metadata = { title: "Documents" };

const FILTER_LABELS: Record<QueueFilter, string> = {
  awaiting: "Awaiting review",
  expiring: "Expiring soon",
  expired: "Expired",
  rejected: "Rejected",
  missing: "Missing",
};

type SP = Record<string, string | undefined>;

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePage("documents.view");
  const sp = await searchParams;
  const filter = (QUEUE_FILTERS as readonly string[]).includes(sp.filter ?? "") ? (sp.filter as QueueFilter) : "awaiting";
  const withinDays = [30, 60, 90].includes(Number(sp.within)) ? Number(sp.within) : 30;
  const page = Math.max(1, Number(sp.page) || 1);

  const { rows, total, counts, pageSize } = await listDocumentQueue(user, { filter, withinDays, q: sp.q, page });
  await audit({ actor: user, action: "read", entityType: "document", summary: `Viewed document queue (${filter})` });

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const qs = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    const merged: SP = { filter, within: String(withinDays), q: sp.q, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/documents?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Documents"
        description="Review queue across the candidates you can access. Open a candidate to upload, verify or download files."
      />

      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Document filters">
        {QUEUE_FILTERS.map((f) => (
          <Link
            key={f}
            href={qs({ filter: f, page: "" })}
            aria-current={f === filter ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm",
              f === filter ? "border-primary bg-secondary font-medium text-secondary-foreground" : "bg-card hover:bg-muted",
            )}
          >
            {FILTER_LABELS[f]}
            <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{counts[f]}</span>
          </Link>
        ))}
      </nav>

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 border-b p-4">
          <input type="hidden" name="filter" value={filter} />
          <Input name="q" defaultValue={sp.q ?? ""} placeholder="Search candidate name or code…" className="w-64" />
          {filter === "expiring" && (
            <Select name="within" defaultValue={String(withinDays)} className="w-40" aria-label="Expiring within">
              <option value="30">Within 30 days</option>
              <option value="60">Within 60 days</option>
              <option value="90">Within 90 days</option>
            </Select>
          )}
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>

        {rows.length === 0 ? (
          <EmptyState
            title="Nothing here"
            description={filter === "missing" ? "No required documents are missing for the candidates you can access." : "No documents match this filter."}
          />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>Candidate</TH>
                  <TH>Document</TH>
                  <TH>Status</TH>
                  <TH>{filter === "awaiting" || filter === "rejected" ? "Uploaded" : "Expiry"}</TH>
                  <TH />
                </tr>
              </THead>
              <tbody>
                {rows.map((r) => (
                  <TR key={r.key}>
                    <TD>
                      <Link href={`/candidates/${r.candidateId}?tab=documents`} className="font-medium hover:underline">
                        {r.candidateName}
                      </Link>
                      <p className="text-xs text-muted-foreground">{r.candidateCode}</p>
                    </TD>
                    <TD>
                      {r.typeLabel}
                      {r.fileName && (
                        <p className="text-xs text-muted-foreground">
                          {r.fileName} · v{r.version}
                        </p>
                      )}
                    </TD>
                    <TD>
                      <DocStatusBadge status={r.status} />
                    </TD>
                    <TD className="text-sm">
                      {filter === "awaiting" || filter === "rejected"
                        ? r.uploadedAt
                          ? formatDate(r.uploadedAt.slice(0, 10))
                          : "—"
                        : r.expiryDate
                          ? `${formatDate(r.expiryDate)}${r.daysLeft != null ? ` (${r.daysLeft < 0 ? `${-r.daysLeft}d ago` : `in ${r.daysLeft}d`})` : ""}`
                          : "—"}
                    </TD>
                    <TD className="text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/candidates/${r.candidateId}?tab=documents`}>
                          {r.kind === "missing" ? "Upload" : can(user, "documents.verify") && filter === "awaiting" ? "Review" : "Open"}
                        </Link>
                      </Button>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
          <span>
            {total.toLocaleString()} item{total === 1 ? "" : "s"} · page {page} of {pages}
          </span>
          <div className="flex items-center gap-2">
            {page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={qs({ page: String(page - 1) })}>Previous</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild variant="outline" size="sm">
                <Link href={qs({ page: String(page + 1) })}>Next</Link>
              </Button>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}
