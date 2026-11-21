import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requirePage } from "@/lib/auth/guard";
import { PageHeader } from "@/components/layout/page-header";
import { formatMinorPlain } from "@/lib/payments/money";
import { getPaymentDetail } from "@/lib/payments/queries";
import { PaymentForm } from "@/modules/payments/payment-form";
import { PaymentNotFoundError } from "@/lib/payments/errors";

export const metadata: Metadata = { title: "Edit draft payment" };

export default async function EditPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePage("payments.prepare");
  const { id } = await params;
  let d;
  try {
    d = await getPaymentDetail(user, id);
  } catch (e) {
    if (e instanceof PaymentNotFoundError) notFound();
    throw e;
  }
  const p = d.payment;
  if (p.status !== "draft") redirect(`/payments/${id}`); // money fields are frozen once a payment leaves Draft
  return (
    <>
      <PageHeader title="Edit draft payment" description="Money fields can only be changed while the payment is a Draft." />
      <PaymentForm
        mode="edit"
        initial={{
          id: p.id,
          candidateId: p.candidateId,
          candidateLabel: `${p.candidateCode ?? ""} · ${p.candidateName ?? ""}`,
          type: p.type,
          amount: formatMinorPlain(p.amountMinor, p.currency),
          currency: p.currency,
          fee: p.feeMinor ? formatMinorPlain(p.feeMinor, p.currency) : undefined,
          fxRate: p.fxRate ?? undefined,
          convertedCurrency: p.convertedCurrency ?? undefined,
          fxQuotedAt: p.fxQuotedAt ?? undefined,
          reason: p.reason,
          payPeriodStart: p.payPeriodStart ?? undefined,
          payPeriodEnd: p.payPeriodEnd ?? undefined,
          invoiceRef: p.invoiceRef ?? undefined,
          recipientName: p.recipientName ?? undefined,
          recipientDestination: p.recipientDestination ?? undefined,
          providerReference: p.providerReference ?? undefined,
          linkedPaymentId: p.linkedPaymentId ?? undefined,
          retryOf: p.retryOf ?? undefined,
        }}
      />
    </>
  );
}
