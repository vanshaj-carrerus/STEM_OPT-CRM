import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { PAYMENT_TYPE_LABELS } from "@/lib/payments/rules";
import { formatMinor } from "@/lib/payments/money";
import { fmtDate } from "@/lib/payments/ui";
import type { PaymentView } from "@/lib/payments/view";
import { PaymentStatusBadge } from "./status-badge";

/** Ledger table (server component). `recipientDestination` is only present for roles holding payments.destination.view. */
export function PaymentTable({ rows, showCandidate = true, showDestination }: { rows: PaymentView[]; showCandidate?: boolean; showDestination: boolean }) {
  if (rows.length === 0) return <EmptyState title="No payments found" description="Adjust the filters, or create a payment from a candidate record." />;
  return (
    <TableWrap>
      <Table>
        <THead>
          <tr>
            <TH>Created</TH>
            {showCandidate && <TH>Candidate</TH>}
            <TH>Type</TH>
            <TH>Recipient</TH>
            <TH className="text-right">Amount</TH>
            <TH>Reference</TH>
            <TH>Status</TH>
            <TH>Flags</TH>
            <TH>
              <span className="sr-only">Open</span>
            </TH>
          </tr>
        </THead>
        <tbody>
          {rows.map((r) => (
            <TR key={r.id}>
              <TD className="whitespace-nowrap text-muted-foreground">{fmtDate(r.createdAt)}</TD>
              {showCandidate && (
                <TD>
                  <Link href={`/candidates/${r.candidateId}?tab=payments`} className="text-primary hover:underline">
                    {r.candidateName ?? r.candidateCode ?? r.candidateId.slice(0, 8)}
                  </Link>
                </TD>
              )}
              <TD>{PAYMENT_TYPE_LABELS[r.type]}</TD>
              <TD>
                {r.recipientName ?? <span className="text-muted-foreground">—</span>}
                {showDestination && r.recipientDestination && <span className="block text-xs text-muted-foreground">{r.recipientDestination}</span>}
              </TD>
              <TD className="whitespace-nowrap text-right tabular-nums">
                {formatMinor(r.amountMinor, r.currency)}
                {r.adjustmentMinor !== 0 && <span className="block text-xs text-muted-foreground">net {formatMinor(r.netMinor, r.currency)}</span>}
                {r.convertedAmountMinor !== null && r.convertedCurrency && <span className="block text-xs text-muted-foreground">≈ {formatMinor(r.convertedAmountMinor, r.convertedCurrency)}</span>}
              </TD>
              <TD className="whitespace-nowrap text-xs">{r.providerReference ?? <span className="text-muted-foreground">—</span>}</TD>
              <TD>
                <div className="flex flex-wrap items-center gap-1">
                  <PaymentStatusBadge status={r.status} />
                  {r.highRisk && <Badge tone="warning">High risk</Badge>}
                </div>
              </TD>
              <TD>
                {r.flags.length > 0 ? (
                  <span title={r.flags.join("\n")} className="inline-flex items-center gap-1 text-xs text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" /> {r.flags.length}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TD>
              <TD>
                <Link href={`/payments/${r.id}`} className="text-xs font-medium text-primary hover:underline">
                  Open
                </Link>
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}
