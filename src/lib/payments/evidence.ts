import type { PaymentType } from "./rules";

export const RECEIPT_KINDS = ["receipt", "remittance_advice", "bank_confirmation", "provider_callback", "other"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const RECEIPT_KIND_LABELS: Record<ReceiptKind, string> = {
  receipt: "Transfer receipt",
  remittance_advice: "Remittance advice",
  bank_confirmation: "Bank confirmation",
  provider_callback: "Provider callback",
  other: "Other evidence",
};

/**
 * "Paid" is never taken on a browser's word: a provider/bank reference AND reviewer-visible evidence must exist.
 *  - wires need a bank confirmation (or a verified provider callback)
 *  - Ria transfers need a receipt/remittance advice (or provider callback)
 *  - payroll settlements and others accept any evidence except "other"
 */
export function evidenceSatisfied(type: PaymentType, kinds: readonly string[]): boolean {
  const has = (k: ReceiptKind) => kinds.includes(k);
  switch (type) {
    case "domestic_wire":
    case "international_wire":
      return has("bank_confirmation") || has("provider_callback");
    case "ria_transfer":
      return has("receipt") || has("remittance_advice") || has("provider_callback") || has("bank_confirmation");
    default:
      return has("receipt") || has("remittance_advice") || has("provider_callback") || has("bank_confirmation");
  }
}

export function evidenceRequirementText(type: PaymentType): string {
  switch (type) {
    case "domestic_wire":
    case "international_wire":
      return "Attach the bank confirmation before marking a wire as Paid.";
    default:
      return "Attach a receipt, remittance advice or provider confirmation before marking as Paid.";
  }
}

export const PROVIDER_FOR_TYPE: Record<PaymentType, "ria" | "bank" | "gusto" | null> = {
  payroll_settlement: "gusto",
  ria_transfer: "ria",
  domestic_wire: "bank",
  international_wire: "bank",
  reimbursement: null,
  other: null,
};
