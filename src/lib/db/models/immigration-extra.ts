import { makeSchema, model } from "../base";
import { I983_STATUSES } from "./candidate";

/** Manually recorded unemployment period (verified input; the CRM never infers it from payroll). */
export interface IUnemploymentPeriod {
  _id: string;
  candidateId: string;
  startDate: string;
  endDate?: string | null; // null = ongoing
  notes?: string;
  verifiedBy?: string | null;
  verifiedAt?: Date | null;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const unemployment = makeSchema<IUnemploymentPeriod>({
  candidateId: { type: String, required: true, index: true },
  startDate: { type: String, required: true },
  endDate: { type: String, default: null },
  notes: String,
  verifiedBy: { type: String, default: null },
  verifiedAt: { type: Date, default: null },
  createdBy: String,
});
export const UnemploymentPeriod = model<IUnemploymentPeriod>("UnemploymentPeriod", unemployment, "unemployment_periods");

/** STEM OPT training plan (Form I-983) tracking for one STEM authorization period. */
export interface II983Record {
  _id: string;
  candidateId: string;
  authorizationPeriodId: string;
  status: (typeof I983_STATUSES)[number];
  formVersion?: string; // edition date printed on the form
  studentSignedOn?: string;
  employerSignedOn?: string;
  dsoSubmittedOn?: string;
  trainingPlanSummary?: string;
  evidenceDocumentId?: string | null;
  verification: "unverified" | "verified";
  verifiedBy?: string | null;
  verifiedAt?: Date | null;
  updatedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const i983 = makeSchema<II983Record>({
  candidateId: { type: String, required: true, index: true },
  authorizationPeriodId: { type: String, required: true },
  status: { type: String, enum: I983_STATUSES, default: "not_started" },
  formVersion: String,
  studentSignedOn: String,
  employerSignedOn: String,
  dsoSubmittedOn: String,
  trainingPlanSummary: String,
  evidenceDocumentId: { type: String, default: null },
  verification: { type: String, enum: ["unverified", "verified"], default: "unverified" },
  verifiedBy: { type: String, default: null },
  verifiedAt: { type: Date, default: null },
  updatedBy: String,
});
i983.index({ authorizationPeriodId: 1 }, { unique: true });
export const I983Record = model<II983Record>("I983Record", i983, "i983_records");
