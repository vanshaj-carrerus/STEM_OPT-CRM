import { makeSchema, model } from "../base";
import type { IProtected } from "./candidate";

const Protected = { enc: String, mask: String };

export interface IEmployer {
  _id: string;
  legalName: string;
  legalNameLower: string;
  ein?: IProtected; // restricted
  everifyCompanyId?: IProtected; // restricted
  address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string };
  contacts: { name?: string; email?: string; phone?: string; title?: string }[];
  isClientSite: boolean;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = makeSchema<IEmployer>({
  legalName: { type: String, required: true, trim: true },
  legalNameLower: { type: String, required: true, unique: true, lowercase: true },
  ein: Protected,
  everifyCompanyId: Protected,
  address: { line1: String, line2: String, city: String, state: String, postalCode: String },
  contacts: { type: [{ name: String, email: String, phone: String, title: String }], default: [] },
  isClientSite: { type: Boolean, default: false },
  notes: String,
});

export const Employer = model<IEmployer>("Employer", schema, "employers");

/** One row per authorization segment: each CPT segment is employer + date specific (long spec §3, AC-03). */
export const AUTH_VERIFICATION_STATES = ["unverified", "verified", "rejected"] as const;

export interface IAuthorizationPeriod {
  _id: string;
  candidateId: string;
  type: "CPT" | "OPT" | "STEM_OPT";
  category?: string; // EAD category e.g. C03B / C03C
  startDate: string;
  endDate: string;
  employerId?: string | null; // required for CPT
  fullTime?: boolean; // CPT full vs part time
  educationLevel?: string;
  evidenceDocumentId?: string | null; // endorsed I-20 / EAD card
  verification: (typeof AUTH_VERIFICATION_STATES)[number];
  verifiedBy?: string | null;
  verifiedAt?: Date | null;
  notes?: string;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const auth = makeSchema<IAuthorizationPeriod>({
  candidateId: { type: String, required: true, index: true },
  type: { type: String, enum: ["CPT", "OPT", "STEM_OPT"], required: true },
  category: String,
  startDate: { type: String, required: true },
  endDate: { type: String, required: true, index: true },
  employerId: { type: String, default: null },
  fullTime: Boolean,
  educationLevel: String,
  evidenceDocumentId: { type: String, default: null },
  verification: { type: String, enum: AUTH_VERIFICATION_STATES, default: "unverified" },
  verifiedBy: { type: String, default: null },
  verifiedAt: { type: Date, default: null },
  notes: String,
  createdBy: String,
});
export const AuthorizationPeriod = model<IAuthorizationPeriod>("AuthorizationPeriod", auth, "authorization_periods");

export interface IEmploymentRecord {
  _id: string;
  candidateId: string;
  employerId: string;
  jobTitle?: string;
  jobDuties?: string;
  supervisor?: { name?: string; email?: string; phone?: string };
  worksiteName?: string;
  worksiteAddress?: string;
  startDate?: string;
  endDate?: string | null;
  hoursPerWeek?: number;
  payTerms?: string; // restricted: compensation detail
  relatedToDegree?: "yes" | "no" | "needs_review";
  relationReviewNote?: string;
  status: "active" | "ended";
  createdAt: Date;
  updatedAt: Date;
}

const emp = makeSchema<IEmploymentRecord>({
  candidateId: { type: String, required: true, index: true },
  employerId: { type: String, required: true },
  jobTitle: String,
  jobDuties: String,
  supervisor: { name: String, email: String, phone: String },
  worksiteName: String,
  worksiteAddress: String,
  startDate: String,
  endDate: { type: String, default: null },
  hoursPerWeek: Number,
  payTerms: String,
  relatedToDegree: { type: String, enum: ["yes", "no", "needs_review"], default: "needs_review" },
  relationReviewNote: String,
  status: { type: String, enum: ["active", "ended"], default: "active" },
});
export const EmploymentRecord = model<IEmploymentRecord>("EmploymentRecord", emp, "employment_records");
