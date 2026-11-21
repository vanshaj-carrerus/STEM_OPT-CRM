import { makeSchema, model } from "../base";
import { PAYROLL_STATUSES, RECONCILIATION_STATUSES, type PayrollStatus, type ReconciliationStatus } from "@/lib/payroll/rules";

export interface IPayrollTotals {
  grossCents: number;
  netCents: number;
  bonusesCents: number;
  deductionsCents: number;
  adjustmentsCents: number;
  hours: number;
  employeeCount: number;
  currency: string;
}

export interface IPayrollReconciliation {
  status: ReconciliationStatus;
  by?: string | null;
  at?: Date | null;
  note?: string;
  settlementReference?: string; // masked/provider reference only — never a full bank account number
  differenceCents?: number | null;
  registerTotalCents?: number | null;
  providerTotalCents?: number | null;
  settlementTotalCents?: number | null;
}

export interface IApprovalEvent {
  action: "approved" | "approval_reset" | "rejected";
  by: string;
  at: Date;
  reason?: string;
  version: number;
}

export interface IPayrollBatch {
  _id: string;
  provider: "gusto";
  companyRef?: string;
  payPeriod: { start: string; end: string; payDate: string }; // date-only
  kind: "regular" | "adjustment";
  adjustsBatchId?: string | null; // corrections to processed payroll are LINKED adjustment batches
  adjustmentReason?: string;
  status: PayrollStatus;
  /** Increments on every content edit; an approval is only valid for the version it approved. */
  version: number;
  preparedBy: string;
  editorIds: string[]; // everyone who prepared/edited/submitted — none may approve (AC-11)
  submittedAt?: Date | null;
  approvedBy?: string | null;
  approvedAt?: Date | null;
  approvedVersion?: number | null;
  approvalHistory: IApprovalEvent[];
  rejection?: { reason: string; by: string; at: Date } | null;
  externalRef?: string; // Gusto payroll ID
  submittedToProviderAt?: Date | null;
  processedAt?: Date | null;
  processedVia?: "webhook" | "manual_evidence" | null;
  processedBy?: string | null; // human who entered provider evidence (manual path)
  providerEvidenceNote?: string;
  providerEventId?: string | null;
  payStatementRef?: string; // reference only — no pay-statement PDFs are stored
  failureReason?: string;
  voidedReason?: string;
  voidedBy?: string | null;
  voidedAt?: Date | null;
  totals?: IPayrollTotals; // RESTRICTED (payroll.amounts.view)
  reconciliation: IPayrollReconciliation;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = makeSchema<IPayrollBatch>({
  provider: { type: String, enum: ["gusto"], default: "gusto" },
  companyRef: String,
  payPeriod: {
    start: { type: String, required: true },
    end: { type: String, required: true },
    payDate: { type: String, required: true },
  },
  kind: { type: String, enum: ["regular", "adjustment"], default: "regular" },
  adjustsBatchId: { type: String, default: null },
  adjustmentReason: String,
  status: { type: String, enum: PAYROLL_STATUSES, default: "draft", index: true },
  version: { type: Number, default: 1 },
  preparedBy: { type: String, required: true },
  editorIds: { type: [String], default: [] },
  submittedAt: { type: Date, default: null },
  approvedBy: { type: String, default: null },
  approvedAt: { type: Date, default: null },
  approvedVersion: { type: Number, default: null },
  approvalHistory: {
    type: [{ _id: false, action: String, by: String, at: Date, reason: String, version: Number }],
    default: [],
  },
  rejection: { type: { _id: false, reason: String, by: String, at: Date }, default: null },
  externalRef: String,
  submittedToProviderAt: { type: Date, default: null },
  processedAt: { type: Date, default: null },
  processedVia: { type: String, enum: ["webhook", "manual_evidence", null], default: null },
  processedBy: { type: String, default: null },
  providerEvidenceNote: String,
  providerEventId: { type: String, default: null },
  payStatementRef: String,
  failureReason: String,
  voidedReason: String,
  voidedBy: { type: String, default: null },
  voidedAt: { type: Date, default: null },
  totals: {
    type: {
      _id: false,
      grossCents: Number,
      netCents: Number,
      bonusesCents: Number,
      deductionsCents: Number,
      adjustmentsCents: Number,
      hours: Number,
      employeeCount: Number,
      currency: { type: String, default: "USD" },
    },
    default: undefined,
  },
  reconciliation: {
    status: { type: String, enum: RECONCILIATION_STATUSES, default: "pending" },
    by: { type: String, default: null },
    at: { type: Date, default: null },
    note: String,
    settlementReference: String,
    differenceCents: { type: Number, default: null },
    registerTotalCents: { type: Number, default: null },
    providerTotalCents: { type: Number, default: null },
    settlementTotalCents: { type: Number, default: null },
  },
  notes: String,
});

schema.index({ "payPeriod.payDate": -1 });
schema.index({ status: 1, "reconciliation.status": 1 });
// One CRM batch per Gusto payroll ID: a second record can never claim the same provider payroll (AC-13).
schema.index({ provider: 1, externalRef: 1 }, { unique: true, partialFilterExpression: { externalRef: { $type: "string" } } });

export const PayrollBatch = model<IPayrollBatch>("PayrollBatch", schema, "payroll_batches");
