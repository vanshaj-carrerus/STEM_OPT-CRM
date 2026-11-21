import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connectDb } from "@/lib/db/connect";
import { AuditEvent, AUDIT_ACTIONS, type IAuditEvent } from "@/lib/db/models/audit";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Badge, type Tone } from "@/components/ui/badge";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Select, Input } from "@/components/ui/form";

export const metadata: Metadata = { title: "Audit log" };
const PAGE = 50;

const tone = (a: string): Tone =>
  a === "login_failed" || a === "delete" || a === "reject"
    ? "danger"
    : a === "approve" || a === "login"
      ? "success"
      : a === "reveal_sensitive" || a === "export" || a === "download" || a === "permission_change"
        ? "warning"
        : "neutral";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entity?: string; actor?: string; page?: string }>;
}) {
  const me = await getSessionUser();
  if (!me || !can(me, "audit.view")) redirect("/dashboard");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);

  const filter: Record<string, unknown> = {};
  if (sp.action && (AUDIT_ACTIONS as readonly string[]).includes(sp.action)) filter.action = sp.action;
  if (sp.entity) filter.entityType = sp.entity.slice(0, 60);
  if (sp.actor) filter.actorEmail = { $regex: sp.actor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 80), $options: "i" };

  await connectDb();
  const [rows, total] = await Promise.all([
    AuditEvent.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * PAGE)
      .limit(PAGE)
      .lean<IAuditEvent[]>(),
    AuditEvent.countDocuments(filter),
  ]);

  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (sp.action) u.set("action", sp.action);
    if (sp.entity) u.set("entity", sp.entity);
    if (sp.actor) u.set("actor", sp.actor);
    u.set("page", String(p));
    return `?${u}`;
  };

  return (
    <>
      <PageHeader title="Audit log" description="Immutable record of sensitive views, downloads, edits, exports, approvals and status changes." />
      <Card>
        <form className="flex flex-wrap items-end gap-3 border-b p-4" method="get">
          <Select name="action" defaultValue={sp.action ?? ""} className="w-44">
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          <Input name="entity" placeholder="Entity type (e.g. candidate)" defaultValue={sp.entity ?? ""} className="w-56" />
          <Input name="actor" placeholder="Actor email" defaultValue={sp.actor ?? ""} className="w-56" />
          <Button type="submit" variant="secondary">
            Filter
          </Button>
        </form>
        {rows.length === 0 ? (
          <EmptyState title="No audit events match" />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>Actor</TH>
                  <TH>Action</TH>
                  <TH>Entity</TH>
                  <TH>Details</TH>
                  <TH>IP</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((r) => (
                  <TR key={r._id}>
                    <TD className="whitespace-nowrap text-muted-foreground">{new Date(r.createdAt).toLocaleString("en-US")}</TD>
                    <TD>
                      <div className="font-medium">{r.actorEmail ?? "system"}</div>
                      {r.actorRole && <div className="text-xs text-muted-foreground">{r.actorRole}</div>}
                    </TD>
                    <TD>
                      <Badge tone={tone(r.action)}>{r.action}</Badge>
                    </TD>
                    <TD className="text-muted-foreground">
                      {r.entityType}
                      {r.entityId && <span className="block font-mono text-[11px]">{r.entityId.slice(0, 8)}</span>}
                    </TD>
                    <TD className="max-w-md">
                      {r.summary}
                      {r.reason && <span className="block text-xs text-muted-foreground">Reason: {r.reason}</span>}
                    </TD>
                    <TD className="font-mono text-xs text-muted-foreground">{r.ip ?? "—"}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
          <span>
            {total.toLocaleString()} events · page {page} of {Math.max(1, Math.ceil(total / PAGE))}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={qs(page - 1)}>Previous</Link>
              </Button>
            )}
            {page * PAGE < total && (
              <Button asChild variant="outline" size="sm">
                <Link href={qs(page + 1)}>Next</Link>
              </Button>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}
