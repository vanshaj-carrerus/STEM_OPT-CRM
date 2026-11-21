import type { PayrollStatus } from "./rules";
import { BLOCKING_FLAGS, type ExceptionFlag } from "./register-csv";

/**
 * Pure batch-editing / approval rules (AC-11 + "any edit after approval resets to Needs Review").
 * Mutations in the service layer call these so the rule cannot drift between UI, API and import paths.
 */

/** Statuses in which batch content may still be edited. processing/processed/voided are frozen. */
export const EDITABLE_STATUSES: PayrollStatus[] = ["draft", "needs_review", "approved", "failed"];

export function canEditBatch(status: PayrollStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

/**
 * The status a batch must have AFTER an edit. An approved (or failed) batch is pushed back to Needs Review and its
 * approval is invalidated — fresh approval by a different person is required.
 */
export function statusAfterEdit(status: PayrollStatus): PayrollStatus {
  if (status === "approved" || status === "failed") return "needs_review";
  return status;
}

export function editInvalidatesApproval(status: PayrollStatus): boolean {
  return status === "approved";
}

/** Everyone who touched the batch (the preparer is always an editor). */
export function nextEditorIds(existing: readonly string[], preparedBy: string, editorId: string): string[] {
  return [...new Set([...existing, preparedBy, editorId])];
}

export interface ApprovalCheckItem {
  status: "ok" | "flagged" | "excluded";
  exceptionFlags: readonly string[];
}

/** Reasons a batch cannot be approved yet (empty array = approvable). */
export function approvalBlockers(items: readonly ApprovalCheckItem[]): string[] {
  const active = items.filter((i) => i.status !== "excluded");
  const out: string[] = [];
  if (active.length === 0) out.push("The batch has no payroll items.");
  const blocked = active.filter((i) => i.exceptionFlags.some((f) => BLOCKING_FLAGS.includes(f as ExceptionFlag)));
  if (blocked.length) out.push(`${blocked.length} item(s) are not mapped to a candidate — map them or exclude them with a reason.`);
  return out;
}

export interface TotalsItem {
  status: "ok" | "flagged" | "excluded";
  hours: number | null;
  grossCents: number | null;
  netCents: number | null;
  bonusesCents: number;
  deductionsCents: number;
  adjustmentsCents: number;
}

export function computeTotals(items: readonly TotalsItem[], currency = "USD") {
  const t = { grossCents: 0, netCents: 0, bonusesCents: 0, deductionsCents: 0, adjustmentsCents: 0, hours: 0, employeeCount: 0, currency };
  for (const i of items) {
    if (i.status === "excluded") continue;
    t.grossCents += i.grossCents ?? 0;
    t.netCents += i.netCents ?? 0;
    t.bonusesCents += i.bonusesCents ?? 0;
    t.deductionsCents += i.deductionsCents ?? 0;
    t.adjustmentsCents += i.adjustmentsCents ?? 0;
    t.hours = Math.round((t.hours + (i.hours ?? 0)) * 100) / 100;
    t.employeeCount++;
  }
  return t;
}
