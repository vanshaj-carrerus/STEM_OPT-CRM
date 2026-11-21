import { connectDb } from "@/lib/db/connect";
import { AuditEvent, type IAuditEvent } from "@/lib/db/models/audit";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";

/** Per-candidate audit trail (create/update/approve/status changes, sensitive reveals, downloads). Caller verifies audit.view. */
export async function ActivityTab({ candidateId }: { candidateId: string }) {
  await connectDb();
  const rows = await AuditEvent.find({ candidateId }).sort({ createdAt: -1 }).limit(200).lean<IAuditEvent[]>();
  return (
    <Card>
      <CardHeader title="Activity & audit" description="Immutable history of everything that happened on this record." />
      {rows.length === 0 ? (
        <EmptyState title="No activity recorded yet" />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <tr>
                <TH>When</TH>
                <TH>Who</TH>
                <TH>Action</TH>
                <TH>Details</TH>
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => (
                <TR key={r._id}>
                  <TD className="whitespace-nowrap text-muted-foreground">{new Date(r.createdAt).toLocaleString("en-US")}</TD>
                  <TD>{r.actorEmail ?? "system"}</TD>
                  <TD>
                    <Badge tone="neutral">{r.action}</Badge>
                  </TD>
                  <TD>
                    {r.summary}
                    {r.reason && <span className="block text-xs text-muted-foreground">Reason: {r.reason}</span>}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}
