import { netSettled, type LedgerRow, type PaymentStatus, type PaymentType } from "./rules";
import { currencyExponent, minorToMajor } from "./money";

/**
 * Uses the shared `netSettled` engine (Paid/Reconciled only; Payroll vs Remittance in separate buckets, per currency)
 * and converts the result back to exact minor units. Gusto payroll settlements are never added to Ria/wire remittances.
 */
export function settledTotalsMinor(rows: { type: PaymentType; status: PaymentStatus; amountMinor: number; adjustmentMinor: number; currency: string }[]) {
  const ledger: LedgerRow[] = rows.map((r) => ({
    type: r.type,
    status: r.status,
    amount: minorToMajor(r.amountMinor, r.currency),
    currency: r.currency,
    adjustments: r.adjustmentMinor ? [minorToMajor(r.adjustmentMinor, r.currency)] : [],
  }));
  const net = netSettled(ledger);
  const toMinor = (bucket: Record<string, number>) =>
    Object.fromEntries(Object.entries(bucket).map(([cur, major]) => [cur, Math.round(major * 10 ** currencyExponent(cur))]));
  return { payroll: toMinor(net.payroll), remittance: toMinor(net.remittance) };
}
