import { Badge, type Tone } from "@/components/ui/badge";
import { payrollDisplayState, type EmergencyStatus, type PayrollStatus, type ReconciliationStatus } from "@/lib/payroll/rules";
import { EMERGENCY_LABELS } from "@/lib/payroll/emergency-logic";
import { EXCEPTION_FLAG_LABELS, type ExceptionFlag } from "@/lib/payroll/register-csv";

const BATCH_TONE: Record<PayrollStatus, Tone> = {
  draft: "neutral",
  needs_review: "warning",
  approved: "info",
  processing: "info",
  processed: "success",
  failed: "danger",
  voided: "neutral",
};

export function BatchStatusBadge({ status, reconciliation = "pending" }: { status: PayrollStatus; reconciliation?: ReconciliationStatus }) {
  let tone = BATCH_TONE[status];
  if (status === "processed") tone = reconciliation === "reconciled" ? "success" : reconciliation === "mismatch" ? "danger" : "warning";
  return <Badge tone={tone}>{payrollDisplayState(status, reconciliation)}</Badge>;
}

const EMERGENCY_TONE: Record<EmergencyStatus, Tone> = {
  open: "neutral",
  processing: "info",
  pending_reconciliation: "warning",
  action_required: "danger",
  resolved: "success",
  removed: "neutral",
};

export function EmergencyStatusBadge({ status }: { status: EmergencyStatus }) {
  return <Badge tone={EMERGENCY_TONE[status]}>{EMERGENCY_LABELS[status]}</Badge>;
}

export function FlagBadges({ flags }: { flags: readonly string[] }) {
  if (!flags.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <Badge key={f} tone={f === "unmatched_employee" ? "danger" : "warning"}>
          {EXCEPTION_FLAG_LABELS[f as ExceptionFlag] ?? f}
        </Badge>
      ))}
    </div>
  );
}

/** Payroll status is never a work-eligibility signal — shown wherever payroll data appears next to a person. */
export function PayrollNotice() {
  return (
    <p className="text-xs text-muted-foreground">
      Payroll and payment status is operational tracking only. It does not indicate or confirm a candidate&apos;s immigration or work-eligibility status.
    </p>
  );
}
