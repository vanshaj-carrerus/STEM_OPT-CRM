import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";
import { listSyncLogs } from "@/lib/payroll/queries";
import { gustoRoute, GUSTO_ROUTE_LABELS } from "@/lib/integrations/gusto/adapter";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/form";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { ActionForm } from "../components/action-form";
import { syncAction } from "@/app/(app)/payroll/actions";

export async function SyncSection({ user, onlyProblems = false }: { user: SessionUser; onlyProblems?: boolean }) {
  const [logs, route] = await Promise.all([listSyncLogs(user, { onlyProblems, limit: 100 }), gustoRoute()]);
  return (
    <div className="space-y-5">
      {!onlyProblems && (
        <Card>
          <CardHeader title="Gusto sync" description={`Route: ${GUSTO_ROUTE_LABELS[route.route]} · adapter: ${route.adapter}`} />
          <CardBody className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {route.liveSync
                ? "Request a status check for a pay period. Provider state is applied through the same guarded transitions as webhooks."
                : "No provider connection is configured: a sync request makes no network call and is only logged. Enter provider evidence on the batch or import the register CSV instead."}
            </p>
            {can(user, "payroll.prepare") && (
              <ActionForm action={syncAction} submit="Run sync" inline>
                <Field label="Period start" htmlFor="sync-start">
                  <Input id="sync-start" name="start" type="date" required />
                </Field>
                <Field label="Period end" htmlFor="sync-end">
                  <Input id="sync-end" name="end" type="date" required />
                </Field>
              </ActionForm>
            )}
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader title={onlyProblems ? "Sync warnings & errors" : "Sync & import log"} description="Every import, sync, webhook, evidence and reconciliation event is recorded here." />
        {logs.length === 0 ? (
          <EmptyState title="No log entries yet" />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>Kind</TH>
                  <TH>Level</TH>
                  <TH>Message</TH>
                </tr>
              </THead>
              <tbody>
                {logs.map((l) => (
                  <TR key={l._id}>
                    <TD className="whitespace-nowrap text-muted-foreground">{new Date(l.createdAt).toLocaleString("en-US")}</TD>
                    <TD>
                      <Badge>{l.kind}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={l.level === "error" ? "danger" : l.level === "warn" ? "warning" : "neutral"}>{l.level}</Badge>
                    </TD>
                    <TD className="text-sm">{l.message}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
