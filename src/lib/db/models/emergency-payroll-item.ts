import { makeSchema, model } from "../base";
import { EMERGENCY_STATUSES, type EmergencyStatus } from "@/lib/payroll/rules";

export interface IEmergencyHistory {
  at: Date;
  by?: string | null; // null = system / provider event
  action: string; // flagged | status_change | linked | override_requested | override_approved | override_rejected | reviewer_confirmed | escalated | updated
  fromStatus?: EmergencyStatus | null;
  toStatus?: EmergencyStatus | null;
  note?: string;
}

export interface IEmergencyOverride {
  kind: "exception" | "removal";
  reason: string;
  requestedBy: string;
  requestedAt: Date;
  status: "pending" | "approved" | "rejected";
  decidedBy?: string | null;
  decidedAt?: Date | null;
  decisionNote?: string;
}

export interface IEmergencyPayrollItem {
  _id: string;
  candidateId: string;
  reason: string;
  requestedPayDate: string; // date-only deadline
  ownerId: string | null;
  priority: "normal" | "high" | "urgent";
  payrollPeriod?: { start: string; end: string } | null;
  batchId?: string | null;
  status: EmergencyStatus;
  /** Denormalised `isActiveEmergency(status)` so a partial unique index can allow one active item per candidate. */
  isActive: boolean;
  actionRequired: boolean;
  actionReason?: string | null;
  escalationLevel: number;
  escalatedAt?: Date | null;
  reviewerConfirmed: boolean;
  reviewerConfirmedBy?: string | null;
  reviewerConfirmedAt?: Date | null;
  reviewerNote?: string;
  override?: IEmergencyOverride | null;
  resolvedAt?: Date | null;
  resolvedVia?: "reconciliation" | "exception" | "removal" | null;
  requestedBy: string;
  history: IEmergencyHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const schema = makeSchema<IEmergencyPayrollItem>({
  candidateId: { type: String, required: true },
  reason: { type: String, required: true },
  requestedPayDate: { type: String, required: true, index: true },
  ownerId: { type: String, default: null, index: true },
  priority: { type: String, enum: ["normal", "high", "urgent"], default: "high" },
  payrollPeriod: { type: { _id: false, start: String, end: String }, default: null },
  batchId: { type: String, default: null, index: true },
  status: { type: String, enum: EMERGENCY_STATUSES, default: "open", index: true },
  isActive: { type: Boolean, default: true },
  actionRequired: { type: Boolean, default: false },
  actionReason: { type: String, default: null },
  escalationLevel: { type: Number, default: 0 },
  escalatedAt: { type: Date, default: null },
  reviewerConfirmed: { type: Boolean, default: false },
  reviewerConfirmedBy: { type: String, default: null },
  reviewerConfirmedAt: { type: Date, default: null },
  reviewerNote: String,
  override: {
    type: {
      _id: false,
      kind: { type: String, enum: ["exception", "removal"] },
      reason: String,
      requestedBy: String,
      requestedAt: Date,
      status: { type: String, enum: ["pending", "approved", "rejected"] },
      decidedBy: String,
      decidedAt: Date,
      decisionNote: String,
    },
    default: null,
  },
  resolvedAt: { type: Date, default: null },
  resolvedVia: { type: String, enum: ["reconciliation", "exception", "removal", null], default: null },
  requestedBy: { type: String, required: true },
  history: {
    type: [{ _id: false, at: Date, by: String, action: String, fromStatus: String, toStatus: String, note: String }],
    default: [],
  },
});

// A temporary queue flag, not a status: at most ONE active emergency item per candidate at a time.
// Explicitly NAMED + distinct key. Previously this was an UNNAMED unique-partial index on {candidateId:1}: MongoDB auto-named
// it "candidateId_1", which collided with the plain candidateId index, so it was never created and nothing in the
// database stopped two active emergency items for one candidate.
schema.index(
  { candidateId: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true }, name: "one_active_emergency_per_candidate" },
);
schema.index({ candidateId: 1, createdAt: -1 }); // candidate history lookups (resolved + active)
schema.index({ isActive: 1, requestedPayDate: 1 });

export const EmergencyPayrollItem = model<IEmergencyPayrollItem>("EmergencyPayrollItem", schema, "emergency_payroll_items");
