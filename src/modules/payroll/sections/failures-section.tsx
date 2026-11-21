import Link from "next/link";
import type { SessionUser } from "@/lib/auth/session";
import { listBatches } from "@/lib/payroll/queries";
import type { PayrollStatus, ReconciliationStatus } from "@/lib/payroll/rules";
import { formatDate } from "@/lib/compliance/dates";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { BatchStatusBadge } from "../components/badges";
import { SyncSection } from "./sync-section";

/** Failed payroll, reconciliation mismatches and sync/webhook problems — everything that needs a human. */
export async function FailuresSection({ user }: { user: SessionUser }) {
  const [failed, mismatched] = await Promise.all([listBatches(user, { status: "failed", pageSize: 50 }), listBatches(user, { reconciliation: "mismatch", pageSize: 50 })]);
  const rows = [...failed.rows, ...mismatched.rows];
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Failed payroll & reconciliation mismatches" description="Each has an exception task and keeps any linked emergency payroll item active (Action Required)." />
        {rows.length === 0 ? (
          <EmptyState title="Nothing needs attention" />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>Pay period</TH>
                  <TH>State</TH>
                  <TH>Detail</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((b) => (
                  <TR key={b._id}>
                    <TD>
                      <Link href={`/payroll/${b._id}`} className="font-medium text-primary hover:underline">
                        {formatDate(b.payPeriod?.start)} – {formatDate(b.payPeriod?.end)}
                      </Link>
                    </TD>
                    <TD>
                      <BatchStatusBadge status={b.status as PayrollStatus} reconciliation={(b.reconciliation?.status ?? "pending") as ReconciliationStatus} />
                    </TD>
                    <TD className="text-sm text-muted-foreground">{b.status === "failed" ? (b.failureReason ?? "Failed") : (b.reconciliation?.note ?? "Totals do not agree — review the reconciliation.")}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
      <SyncSection user={user} onlyProblems />
    </div>
  );
}
