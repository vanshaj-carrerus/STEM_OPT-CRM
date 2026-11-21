import { Badge } from "@/components/ui/badge";
import { PAYMENT_STATUS_LABELS } from "@/lib/payments/rules";
import { formatMinor } from "@/lib/payments/money";
import { fmtDateTime } from "@/lib/payments/ui";
import type { PaymentDetail } from "@/lib/payments/queries";

const KIND_LABEL: Record<string, string> = {
  created: "Created",
  edited: "Edited (draft)",
  approval_requested: "Sent for approval",
  approved: "Approval recorded",
  rejected: "Rejected",
  status_change: "Status change",
  partial: "Partial payment",
  return: "Return",
  correction: "Correction",
  cancellation: "Cancelled",
  reversal: "Reversed / returned",
  receipt: "Evidence added",
  reconciled: "Reconciled",
  flag: "Flagged",
  note: "Note",
  webhook: "Provider callback",
};

/** Append-only history. Contains no destination data, so it is safe for every payments.view role. */
export function PaymentTimeline({ events, currency }: { events: PaymentDetail["events"]; currency: string }) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No events yet.</p>;
  return (
    <ol className="space-y-3">
      {[...events].reverse().map((e) => (
        <li key={e._id} className="rounded-md border bg-card px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={e.kind === "rejected" || e.kind === "reversal" || e.kind === "return" ? "danger" : e.kind === "flag" ? "warning" : "neutral"}>{KIND_LABEL[e.kind] ?? e.kind}</Badge>
              {e.toStatus && (
                <span className="text-xs text-muted-foreground">
                  {e.fromStatus ? `${PAYMENT_STATUS_LABELS[e.fromStatus]} → ` : ""}
                  {PAYMENT_STATUS_LABELS[e.toStatus]}
                </span>
              )}
              {e.amountDeltaMinor !== 0 && <span className="text-xs font-medium tabular-nums">{formatMinor(e.amountDeltaMinor, e.currency ?? currency)}</span>}
            </div>
            <span className="text-xs text-muted-foreground">
              {fmtDateTime(e.createdAt)} · {e.actorName ?? (e.actorType === "webhook" ? "Provider callback" : "System")}
            </span>
          </div>
          {e.reason && <p className="mt-1.5 text-muted-foreground">{e.reason}</p>}
        </li>
      ))}
    </ol>
  );
}
