import type { Metadata } from "next";
import { loadCandidateFor, requirePage } from "@/lib/auth/guard";
import { PageHeader } from "@/components/layout/page-header";
import { formatMinorPlain } from "@/lib/payments/money";
import { loadPaymentFor } from "@/lib/payments/core";
import { PaymentForm, type PaymentFormInitial } from "@/modules/payments/payment-form";
import { RiaBanner } from "@/modules/payments/ria-banner";

export const metadata: Metadata = { title: "New payment" };

export default async function NewPaymentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePage("payments.prepare");
  const sp = await searchParams;
  const initial: PaymentFormInitial = {};

  // "create linked payment": remainder / correction (linked=<id>) or replacement of a failed/cancelled one (retry=<id>)
  const sourceId = sp.retry || sp.linked;
  if (sourceId) {
    try {
      const src = await loadPaymentFor(user, sourceId);
      initial.candidateId = src.candidateId;
      initial.type = src.type;
      initial.currency = src.currency;
      initial.recipientName = src.recipientName ?? undefined;
      initial.reason = src.reason;
      initial.convertedCurrency = src.convertedCurrency ?? undefined;
      if (sp.retry) {
        initial.retryOf = src.retryOf ?? sourceId;
        initial.amount = formatMinorPlain(src.amountMinor, src.currency);
        initial.linkedPaymentId = sourceId;
      } else initial.linkedPaymentId = sourceId;
    } catch {
      // not found / not permitted: fall through to a blank form
    }
  }
  const candidateId = sp.candidateId || initial.candidateId;
  if (candidateId) {
    const c = await loadCandidateFor(user, candidateId);
    if (c) {
      initial.candidateId = c._id;
      initial.candidateLabel = `${c.candidateCode} · ${c.legalName}`;
    } else delete initial.candidateId;
  }

  return (
    <>
      <PageHeader title="New payment" description="Prepare a ledger entry for approval. The transfer itself is made outside the CRM." />
      <RiaBanner />
      <PaymentForm mode="create" initial={initial} lockCandidate={!!initial.candidateId && !!sp.candidateId} />
    </>
  );
}
