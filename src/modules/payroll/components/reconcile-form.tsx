"use client";

import { useState } from "react";
import { Field, Input, Textarea } from "@/components/ui/form";
import { ActionForm } from "./action-form";
import type { ActionResult } from "@/lib/payroll/errors";
import { centsToInput, formatCents } from "@/lib/payroll/money";
import { parseAmountCsv } from "@/lib/payroll/register-csv";

/** Reconcile register total (net pay) vs provider report vs actual settlement. Totals may be typed or filled from a CSV. */
export function ReconcileForm({
  batchId,
  registerCents,
  defaults,
  action,
}: {
  batchId: string;
  registerCents: number;
  defaults: { providerCents?: number | null; settlementCents?: number | null; settlementReference?: string; note?: string };
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
}) {
  const [provider, setProvider] = useState(centsToInput(defaults.providerCents));
  const [settlement, setSettlement] = useState(centsToInput(defaults.settlementCents));
  const [reference, setReference] = useState(defaults.settlementReference ?? "");
  const [csvMsg, setCsvMsg] = useState("");

  async function fromCsv(target: "provider" | "settlement", f: File | undefined) {
    if (!f) return;
    const r = parseAmountCsv(await f.text());
    if (r.errors.length && r.count === 0) {
      setCsvMsg(r.errors[0]);
      return;
    }
    const v = centsToInput(r.totalCents);
    if (target === "provider") setProvider(v);
    else {
      setSettlement(v);
      if (!reference && r.references[0]) setReference(r.references[0]);
    }
    setCsvMsg(`Loaded ${r.count} row(s) totalling ${formatCents(r.totalCents)}${r.errors.length ? ` (${r.errors.length} row(s) skipped)` : ""}. Review before saving.`);
  }

  return (
    <ActionForm action={action} submit="Save reconciliation" pendingText="Saving…">
      <input type="hidden" name="batchId" value={batchId} />
      <p className="text-sm">
        CRM payroll register total (net pay): <strong>{formatCents(registerCents)}</strong>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Provider report total (net pay)" htmlFor="providerTotal">
          <Input id="providerTotal" name="providerTotal" inputMode="decimal" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="0.00" />
          <input type="file" accept=".csv" aria-label="Fill provider total from CSV" className="mt-1 block text-xs" onChange={(e) => fromCsv("provider", e.target.files?.[0])} />
        </Field>
        <Field label="Settlement / bank amount" htmlFor="settlementTotal">
          <Input id="settlementTotal" name="settlementTotal" inputMode="decimal" value={settlement} onChange={(e) => setSettlement(e.target.value)} placeholder="0.00" />
          <input type="file" accept=".csv" aria-label="Fill settlement total from CSV" className="mt-1 block text-xs" onChange={(e) => fromCsv("settlement", e.target.files?.[0])} />
        </Field>
        <Field label="Settlement reference" htmlFor="settlementReference" hint="Bank/provider reference or last 4 digits only — never a full account number.">
          <Input id="settlementReference" name="settlementReference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={128} />
        </Field>
        <Field label="Note" htmlFor="note">
          <Textarea id="note" name="note" defaultValue={defaults.note} rows={2} maxLength={1000} />
        </Field>
      </div>
      {csvMsg && <p className="text-xs text-muted-foreground">{csvMsg}</p>}
    </ActionForm>
  );
}
