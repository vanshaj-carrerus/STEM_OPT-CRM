import type { ReconciliationStatus } from "./rules";

/**
 * Reconciliation difference math (pure). All values are integer cents.
 * Compare the payroll REGISTER total (sum of the CRM items) against the PROVIDER report total and the actual
 * SETTLEMENT / bank record. Any difference ⇒ mismatch ⇒ exception task + human review.
 */
export interface ReconcileInput {
  registerCents: number;
  providerCents?: number | null;
  settlementCents?: number | null;
  /** Allowed absolute difference in cents (default 0 — payroll reconciles to the cent). */
  toleranceCents?: number;
  /** A settlement reference is mandatory before anything can be marked reconciled. */
  settlementReference?: string | null;
}

export interface ReconcileResult {
  status: ReconciliationStatus;
  /** Largest-magnitude signed difference (0 when pending). Positive = the later figure is higher. */
  differenceCents: number;
  registerVsProviderCents: number | null; // provider - register
  providerVsSettlementCents: number | null; // settlement - provider
  reasons: string[];
}

export function reconcileTotals(i: ReconcileInput): ReconcileResult {
  const tol = Math.max(0, i.toleranceCents ?? 0);
  const reasons: string[] = [];
  const hasProvider = typeof i.providerCents === "number";
  const hasSettlement = typeof i.settlementCents === "number";

  const registerVsProvider = hasProvider ? (i.providerCents as number) - i.registerCents : null;
  const providerVsSettlement = hasProvider && hasSettlement ? (i.settlementCents as number) - (i.providerCents as number) : null;
  // when there is no provider figure, compare settlement against the register directly
  const registerVsSettlement = !hasProvider && hasSettlement ? (i.settlementCents as number) - i.registerCents : null;

  const diffs = [registerVsProvider, providerVsSettlement, registerVsSettlement].filter((d): d is number => d !== null);
  const largest = diffs.reduce((m, d) => (Math.abs(d) > Math.abs(m) ? d : m), 0);

  if (registerVsProvider !== null && Math.abs(registerVsProvider) > tol) reasons.push("Provider report total differs from the CRM payroll register total.");
  if (providerVsSettlement !== null && Math.abs(providerVsSettlement) > tol) reasons.push("Settlement/bank amount differs from the provider report total.");
  if (registerVsSettlement !== null && Math.abs(registerVsSettlement) > tol) reasons.push("Settlement/bank amount differs from the CRM payroll register total.");

  if (reasons.length) {
    return { status: "mismatch", differenceCents: largest, registerVsProviderCents: registerVsProvider, providerVsSettlementCents: providerVsSettlement, reasons };
  }
  if (!hasProvider || !hasSettlement) {
    reasons.push(!hasProvider ? "Provider report total not entered yet." : "Settlement / bank amount not entered yet.");
    return { status: "pending", differenceCents: 0, registerVsProviderCents: registerVsProvider, providerVsSettlementCents: providerVsSettlement, reasons };
  }
  if (!i.settlementReference?.trim()) {
    reasons.push("A settlement reference is required to mark payroll reconciled.");
    return { status: "pending", differenceCents: 0, registerVsProviderCents: registerVsProvider, providerVsSettlementCents: providerVsSettlement, reasons };
  }
  return { status: "reconciled", differenceCents: 0, registerVsProviderCents: registerVsProvider, providerVsSettlementCents: providerVsSettlement, reasons };
}
