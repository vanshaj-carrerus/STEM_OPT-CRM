import { makeSchema, model } from "../base";
import { PAY_TYPES, type PayType } from "@/lib/payroll/register-csv";

export interface IPayrollItem {
  _id: string;
  batchId: string;
  candidateId: string | null; // null = unmatched register row (never auto-creates a candidate)
  externalEmployeeRef: string; // Gusto employee ID (or UUID)
  employeeName?: string; // as shown in the register; display only
  hours: number | null;
  payType: PayType;
  /** RESTRICTED amounts (payroll.amounts.view) — integer cents. */
  grossCents: number | null;
  netCents: number | null;
  adjustmentsCents: number;
  bonusesCents: number;
  deductionsCents: number;
  adjustmentNote?: string;
  exceptionFlags: string[];
  status: "ok" | "flagged" | "excluded";
  excludedReason?: string;
  kind: "regular" | "adjustment";
  adjustsItemId?: string | null;
  source: "manual" | "csv_import";
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = makeSchema<IPayrollItem>({
  batchId: { type: String, required: true, index: true },
  candidateId: { type: String, default: null, index: true },
  externalEmployeeRef: { type: String, required: true },
  employeeName: String,
  hours: { type: Number, default: null },
  payType: { type: String, enum: PAY_TYPES, default: "hourly" },
  grossCents: { type: Number, default: null },
  netCents: { type: Number, default: null },
  adjustmentsCents: { type: Number, default: 0 },
  bonusesCents: { type: Number, default: 0 },
  deductionsCents: { type: Number, default: 0 },
  adjustmentNote: String,
  exceptionFlags: { type: [String], default: [] },
  status: { type: String, enum: ["ok", "flagged", "excluded"], default: "ok" },
  excludedReason: String,
  kind: { type: String, enum: ["regular", "adjustment"], default: "regular" },
  adjustsItemId: { type: String, default: null },
  source: { type: String, enum: ["manual", "csv_import"], default: "manual" },
  createdBy: String,
  updatedBy: String,
});

// Idempotent import: re-importing the same register can never create a second row for an employee (AC-13 spirit).
schema.index({ batchId: 1, externalEmployeeRef: 1 }, { unique: true });

export const PayrollItem = model<IPayrollItem>("PayrollItem", schema, "payroll_items");
