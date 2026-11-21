"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormAlert, Input, Select, SubmitButton, Textarea } from "@/components/ui/form";
import { PAYMENT_TYPES, PAYMENT_TYPE_LABELS } from "@/lib/payments/rules";
import { COMMON_CURRENCIES, formatMinor } from "@/lib/payments/money";
import { createPaymentAction, previewRiskAction, updatePaymentAction, type PaymentFormState } from "@/app/(app)/payments/actions";
import { CandidatePicker } from "./candidate-picker";

export interface PaymentFormInitial {
  id?: string;
  candidateId?: string;
  candidateLabel?: string;
  type?: string;
  amount?: string;
  currency?: string;
  fee?: string;
  fxRate?: string;
  convertedCurrency?: string;
  fxQuotedAt?: string; // ISO
  reason?: string;
  payPeriodStart?: string;
  payPeriodEnd?: string;
  invoiceRef?: string;
  recipientName?: string;
  recipientDestination?: string;
  providerReference?: string;
  linkedPaymentId?: string;
  retryOf?: string;
}

interface Preview {
  ok: boolean;
  error?: string;
  highRisk?: boolean;
  requiredApprovals?: number;
  reasons?: string[];
  convertedAmountMinor?: number | null;
  convertedCurrency?: string | null;
  destinationWasMasked?: boolean;
}

const toLocalInput = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function PaymentForm({ mode, initial = {}, lockCandidate = false }: { mode: "create" | "edit"; initial?: PaymentFormInitial; lockCandidate?: boolean }) {
  const [state, action] = useActionState<PaymentFormState, FormData>(mode === "create" ? createPaymentAction : updatePaymentAction, {});
  const fe = state.fieldErrors ?? {};
  const formRef = useRef<HTMLFormElement>(null);
  const [requestKey] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now())));
  const [quoted, setQuoted] = useState(toLocalInput(initial.fxQuotedAt));
  const [type, setType] = useState(initial.type ?? "ria_transfer");
  const [preview, setPreview] = useState<Preview | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const quotedIso = quoted ? new Date(quoted).toISOString() : "";

  function schedulePreview() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const form = formRef.current;
      if (!form) return;
      const values: Record<string, string> = {};
      new FormData(form).forEach((v, k) => {
        if (typeof v === "string") values[k] = v;
      });
      if (!values.candidateId || !values.amount) return setPreview(null);
      values.paymentId = initial.id ?? "";
      setPreview((await previewRiskAction(values)) as Preview);
    }, 450);
  }
  useEffect(() => {
    schedulePreview();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoted, type]);

  const isPayroll = type === "payroll_settlement";

  return (
    <form ref={formRef} action={action} onChange={schedulePreview} className="space-y-6">
      {mode === "edit" && <input type="hidden" name="id" value={initial.id} />}
      <input type="hidden" name="requestKey" value={requestKey} />
      <input type="hidden" name="fxQuotedAt" value={quotedIso} />
      <FormAlert error={state.error} />

      <Card>
        <CardHeader title="Payment" description="Creates a Draft. Nothing is sent from the CRM; the transfer is made in Ria's / the bank's approved channel after approval." />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label="Candidate" required error={fe.candidateId} className="md:col-span-2">
            <CandidatePicker locked={lockCandidate || mode === "edit"} defaultCandidate={initial.candidateId ? { id: initial.candidateId, label: initial.candidateLabel ?? initial.candidateId } : undefined} onChange={() => schedulePreview()} />
          </Field>
          <Field label="Payment type" htmlFor="type" required error={fe.type}>
            <Select id="type" name="type" value={type} onChange={(e) => setType(e.target.value)}>
              {PAYMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PAYMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pay period / invoice / reason" htmlFor="reason" required error={fe.reason}>
            <Input id="reason" name="reason" defaultValue={initial.reason} maxLength={300} required placeholder="e.g. Payroll 1–15 Nov 2026 remittance" />
          </Field>
          <Field label="Amount sent" htmlFor="amount" required error={fe.amount} hint="Exact decimal, e.g. 1250.00">
            <Input id="amount" name="amount" inputMode="decimal" defaultValue={initial.amount} required />
          </Field>
          <Field label="Currency" htmlFor="currency" required error={fe.currency}>
            <Input id="currency" name="currency" list="ccy" defaultValue={initial.currency ?? "USD"} maxLength={3} required className="uppercase" />
            <datalist id="ccy">
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Fee (optional)" htmlFor="fee" error={fe.fee}>
            <Input id="fee" name="fee" inputMode="decimal" defaultValue={initial.fee} />
          </Field>
          <Field label="Invoice reference (optional)" htmlFor="invoiceRef" error={fe.invoiceRef}>
            <Input id="invoiceRef" name="invoiceRef" defaultValue={initial.invoiceRef} maxLength={60} />
          </Field>
          <Field label="Period start" htmlFor="payPeriodStart" error={fe.payPeriodStart}>
            <Input id="payPeriodStart" name="payPeriodStart" type="date" defaultValue={initial.payPeriodStart} />
          </Field>
          <Field label="Period end" htmlFor="payPeriodEnd" error={fe.payPeriodEnd}>
            <Input id="payPeriodEnd" name="payPeriodEnd" type="date" defaultValue={initial.payPeriodEnd} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="FX quote (if converting currency)" description="The converted amount is computed from the rate with integer math. Leave blank when sending and receiving in the same currency." />
        <CardBody className="grid gap-4 md:grid-cols-3">
          <Field label="FX rate" htmlFor="fxRate" error={fe.fxRate} hint="Units of destination currency per 1 sent">
            <Input id="fxRate" name="fxRate" inputMode="decimal" defaultValue={initial.fxRate} />
          </Field>
          <Field label="Destination currency" htmlFor="convertedCurrency" error={fe.convertedCurrency}>
            <Input id="convertedCurrency" name="convertedCurrency" list="ccy" maxLength={3} defaultValue={initial.convertedCurrency} className="uppercase" />
          </Field>
          <Field label="Quote time" htmlFor="quote" error={fe.fxQuotedAt}>
            <div className="flex gap-2">
              <Input id="quote" type="datetime-local" value={quoted} onChange={(e) => setQuoted(e.target.value)} />
              <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setQuoted(toLocalInput(new Date().toISOString()))}>
                Now
              </Button>
            </div>
          </Field>
          {preview?.ok && typeof preview.convertedAmountMinor === "number" && (
            <p className="text-sm text-muted-foreground md:col-span-3">Converted amount (computed): <span className="font-medium text-foreground">{formatMinor(preview.convertedAmountMinor, preview.convertedCurrency ?? "")}</span></p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recipient & references" description="Only masked references are stored. Never enter full account, routing or card numbers; the provider/bank holds the real destination." />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label={isPayroll ? "Recipient name (optional)" : "Recipient name"} htmlFor="recipientName" required={!isPayroll} error={fe.recipientName}>
            <Input id="recipientName" name="recipientName" defaultValue={initial.recipientName} maxLength={120} />
          </Field>
          <Field label="Masked destination reference" htmlFor="recipientDestination" error={fe.recipientDestination} hint={mode === "edit" ? "Leave blank to keep the stored reference. Use e.g. ****1234." : "e.g. ****1234 or a bank nickname. Long digit strings are masked automatically; card numbers are rejected."}>
            <Input id="recipientDestination" name="recipientDestination" defaultValue={initial.recipientDestination} maxLength={160} autoComplete="off" />
          </Field>
          <Field label="Provider / bank / Gusto reference (optional now)" htmlFor="providerReference" error={fe.providerReference} hint="Required later when the transfer is recorded as Submitted.">
            <Input id="providerReference" name="providerReference" defaultValue={initial.providerReference} maxLength={64} />
          </Field>
          <Field label="Adjusts / replaces payment ID (optional)" htmlFor="linkedPaymentId" error={fe.linkedPaymentId} hint="Link a remainder, correction or retry to the original payment.">
            <Input id="linkedPaymentId" name="linkedPaymentId" defaultValue={initial.linkedPaymentId} />
          </Field>
          <input type="hidden" name="retryOf" value={initial.retryOf ?? ""} />
          {preview?.destinationWasMasked && <p className="text-xs text-warning md:col-span-2">The destination looked like a full number and will be stored masked.</p>}
        </CardBody>
      </Card>

      <div aria-live="polite">
        {preview?.ok ? (
          <div className={`flex items-start gap-3 rounded-md border px-4 py-3 text-sm ${preview.highRisk ? "border-warning/40 bg-warning-bg text-warning" : "border-success/30 bg-success-bg text-success"}`}>
            {preview.highRisk ? <ShieldAlert className="mt-0.5 h-4 w-4" /> : <ShieldCheck className="mt-0.5 h-4 w-4" />}
            <div>
              <p className="font-medium">
                {preview.highRisk ? "High-risk payment — dual approval required" : "Standard payment — one approval required"}{" "}
                <Badge tone={preview.highRisk ? "warning" : "success"}>{preview.requiredApprovals} approval{preview.requiredApprovals === 1 ? "" : "s"}</Badge>
              </p>
              {preview.reasons && preview.reasons.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-xs">
                  {preview.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              {preview.highRisk && <p className="mt-1 text-xs">Two distinct approvers (neither the requester) are needed, and a different person must reconcile.</p>}
            </div>
          </div>
        ) : (
          preview && !preview.ok && <p className="text-xs text-muted-foreground">Risk indicator appears once the form is complete.</p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton pendingText="Saving…">{mode === "create" ? "Create draft" : "Save changes"}</SubmitButton>
        <Button asChild variant="ghost">
          <Link href={mode === "edit" && initial.id ? `/payments/${initial.id}` : "/payments"}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
