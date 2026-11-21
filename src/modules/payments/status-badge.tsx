import { Badge } from "@/components/ui/badge";
import { PAYMENT_STATUS_LABELS, type PaymentStatus } from "@/lib/payments/rules";
import { STATUS_TONE } from "@/lib/payments/ui";

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{PAYMENT_STATUS_LABELS[status]}</Badge>;
}
