import { can, type Actor } from "@/lib/rbac/can";
import { PAYROLL_FIELD_RULES, stripRestricted, type FieldRules } from "@/lib/rbac/mask";
import type { IPayrollBatch } from "@/lib/db/models/payroll-batch";
import type { IPayrollItem } from "@/lib/db/models/payroll-item";

/**
 * Server-side amount stripping. Gross/net/pay rate/totals are removed from the payload (not just hidden in the UI)
 * unless the actor holds `payroll.amounts.view`. Used by pages, APIs and the dashboard helpers alike.
 */
export const PAYROLL_AMOUNT_RULES: FieldRules = {
  ...PAYROLL_FIELD_RULES,
  grossCents: "payroll.amounts.view",
  netCents: "payroll.amounts.view",
  bonusesCents: "payroll.amounts.view",
  deductionsCents: "payroll.amounts.view",
  adjustmentsCents: "payroll.amounts.view",
};

const RECON_AMOUNTS = ["differenceCents", "registerTotalCents", "providerTotalCents", "settlementTotalCents"] as const;

export type BatchView = Omit<IPayrollBatch, "totals" | "createdAt" | "updatedAt"> & {
  totals?: IPayrollBatch["totals"];
  hasDifference: boolean;
  createdAt: string;
  updatedAt: string;
};

export function batchView(actor: Actor, b: IPayrollBatch): Partial<BatchView> {
  const plain = JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
  const rec = (plain.reconciliation ?? {}) as Record<string, unknown>;
  plain.hasDifference = rec.status === "mismatch" || (typeof rec.differenceCents === "number" && rec.differenceCents !== 0);
  const stripped = stripRestricted(actor, plain, PAYROLL_AMOUNT_RULES) as Record<string, unknown>;
  if (!can(actor, "payroll.amounts.view") && stripped.reconciliation) {
    const r = { ...(stripped.reconciliation as Record<string, unknown>) };
    for (const k of RECON_AMOUNTS) delete r[k];
    stripped.reconciliation = r;
  }
  return stripped as Partial<BatchView>;
}

export type ItemView = Omit<IPayrollItem, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string };

export function itemView(actor: Actor, i: IPayrollItem): Partial<ItemView> {
  const plain = JSON.parse(JSON.stringify(i)) as Record<string, unknown>;
  return stripRestricted(actor, plain, PAYROLL_AMOUNT_RULES) as Partial<ItemView>;
}
