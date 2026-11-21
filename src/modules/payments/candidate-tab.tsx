import Link from "next/link";
import { Plus } from "lucide-react";
import { requirePage, loadCandidateFor } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatMinor } from "@/lib/payments/money";
import { candidateLedger } from "@/lib/payments/queries";
import type { CandidateTabProps } from "../tab-types";
import { PaymentTable } from "./payment-table";
import { RiaBanner } from "./ria-banner";

function TotalsCard({ title, description, totals }: { title: string; description: string; totals: Record<string, number> }) {
  const entries = Object.entries(totals);
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing settled yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {entries.map(([cur, minor]) => (
              <li key={cur} className="flex justify-between tabular-nums">
                <span className="text-muted-foreground">{cur}</span>
                <span className="font-medium">{formatMinor(minor, cur)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/** Candidate Payments tab: this candidate's ledger + net settled totals (Payroll and Remittance kept separate per currency). */
export async function CandidatePaymentsTab({ candidateId }: CandidateTabProps) {
  const user = await requirePage("payments.view");
  const candidate = await loadCandidateFor(user, candidateId); // record-level access, re-checked here
  if (!candidate) return <Card><CardBody className="text-sm text-muted-foreground">Candidate not found.</CardBody></Card>;
  const { rows, totals } = await candidateLedger(user, candidateId);
  const attention = rows.filter((r) => r.needsAttention).length;

  return (
    <div className="space-y-5">
      <RiaBanner />
      <div className="grid gap-5 md:grid-cols-2">
        <TotalsCard title="Payroll settlements (Gusto)" description="Net settled (Paid + Reconciled) after linked events. Never added to remittances." totals={totals.payroll} />
        <TotalsCard title="Remittances (Ria / wire / other)" description="Net settled (Paid + Reconciled) after returns and corrections." totals={totals.remittance} />
      </div>
      <Card>
        <CardHeader
          title="Payment ledger"
          description={`${rows.length} payment${rows.length === 1 ? "" : "s"}${attention ? ` · ${attention} need attention` : ""}`}
          action={
            can(user, "payments.prepare") ? (
              <Button asChild size="sm">
                <Link href={`/payments/new?candidateId=${candidateId}`}>
                  <Plus className="h-4 w-4" /> New payment
                </Link>
              </Button>
            ) : undefined
          }
        />
        <PaymentTable rows={rows} showCandidate={false} showDestination={can(user, "payments.destination.view")} />
      </Card>
    </div>
  );
}
