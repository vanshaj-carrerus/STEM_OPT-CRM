import { makeSchema, model } from "../base";

/** Encrypted identifier: ciphertext + masked display value (plaintext never persisted). */
const Protected = { enc: String, mask: String };

// Plain constants live in a DB-free module so client components can import them without bundling Mongoose.
import { CANDIDATE_STAGES, STAGE_LABELS, AUTH_TYPES, AUTH_TYPE_LABELS, I983_STATUSES, type CandidateStage, type CandidateAuthType } from "@/lib/candidates/constants";
export { CANDIDATE_STAGES, STAGE_LABELS, AUTH_TYPES, AUTH_TYPE_LABELS, I983_STATUSES };
export type { CandidateStage, CandidateAuthType };

export interface IProtected {
  enc: string;
  mask: string;
}

export interface ICandidateNote {
  _id: string;
  text: string;
  authorId: string;
  authorName?: string;
  createdAt: Date;
}

export interface IContactEntry {
  _id: string;
  channel: "call" | "email" | "meeting" | "message" | "other";
  summary: string;
  byId: string;
  byName?: string;
  at: Date;
}

export interface ICandidate {
  _id: string;
  candidateCode: string; // CND-000001 (human-friendly, never a key)

  // Identity
  legalName: string;
  preferredName?: string;
  email: string;
  emailLower: string;
  phone?: string;
  dateOfBirth?: IProtected;
  address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
  country?: string;
  emergencyContact?: { name?: string; phone?: string; relationship?: string };

  // Education
  school?: string;
  campus?: string;
  degreeLevel?: string;
  degree?: string;
  major?: string;
  stemCipCode?: string;
  programStart?: string; // date-only
  programEnd?: string;
  graduationDate?: string;
  dsoName?: string;
  dsoEmail?: string;
  dsoPhone?: string;

  // Immigration (highly restricted pieces are protected)
  sevisId?: IProtected;
  sevisHash?: string; // HMAC for duplicate detection without storing plaintext
  visaStatus?: string; // e.g. F-1
  authType: CandidateAuthType;
  eadCategory?: string;
  eadNumber?: IProtected;
  eadStart?: string;
  eadEnd?: string;
  i20IssueDate?: string;
  i20EndorsementDate?: string;
  receiptNumber?: string;
  caseStatus?: string;
  i983Status: (typeof I983_STATUSES)[number];
  validationStatus?: string;
  reviewOutcome?: string;

  /** Cleared-to-work is set only through the clearance guard (evidence + reviewer), never by a plain checkbox. */
  clearedToWork: boolean;
  clearedBy?: string | null;
  clearedAt?: Date | null;
  clearedEvidenceDocId?: string | null;

  // Employment summary (detail lives in employment_records)
  currentEmployerId?: string | null;

  // Operations
  ownerId?: string | null; // assigned compliance owner
  /** IANA timezone of the candidate record (school); drives the daily reminder job. Falls back to owner tz, then America/New_York. */
  timezone?: string;
  teamMemberIds: string[];
  recruiterId?: string | null;
  nextDueDate?: string | null; // denormalised: earliest open milestone/task
  riskFlags: string[];

  // Payroll mapping (Gusto is system of record; never assume a candidate is a payroll employee)
  payrollMapping?: {
    provider: "gusto";
    companyRef?: string;
    employeeId?: string;
    paySchedule?: string;
    payType?: string;
    mappedAt?: Date;
    mappedBy?: string;
  };

  // CRM
  source?: string;
  stage: CandidateStage;
  priority: "low" | "normal" | "high" | "urgent";
  tags: string[];
  notes: ICandidateNote[];
  contactHistory: IContactEntry[];

  nameDobHash?: string; // HMAC(lower(legalName)+dob) duplicate signal
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const address = { line1: String, line2: String, city: String, state: String, postalCode: String, country: String };

const schema = makeSchema<ICandidate>({
  candidateCode: { type: String, required: true, unique: true },
  legalName: { type: String, required: true, trim: true, index: true },
  preferredName: String,
  email: { type: String, required: true, trim: true },
  emailLower: { type: String, required: true, lowercase: true, trim: true },
  phone: String,
  dateOfBirth: Protected,
  address,
  country: String,
  emergencyContact: { name: String, phone: String, relationship: String },

  school: String,
  campus: String,
  degreeLevel: String,
  degree: String,
  major: String,
  stemCipCode: String,
  programStart: String,
  programEnd: String,
  graduationDate: String,
  dsoName: String,
  dsoEmail: String,
  dsoPhone: String,

  sevisId: Protected,
  sevisHash: String,
  visaStatus: String,
  authType: { type: String, enum: ["none", "CPT", "OPT", "STEM_OPT"], default: "none", index: true },
  eadCategory: String,
  eadNumber: Protected,
  eadStart: String,
  eadEnd: { type: String, index: true },
  i20IssueDate: String,
  i20EndorsementDate: String,
  receiptNumber: String,
  caseStatus: String,
  i983Status: { type: String, enum: I983_STATUSES, default: "not_applicable" },
  validationStatus: String,
  reviewOutcome: String,

  clearedToWork: { type: Boolean, default: false },
  clearedBy: { type: String, default: null },
  clearedAt: { type: Date, default: null },
  clearedEvidenceDocId: { type: String, default: null },

  currentEmployerId: { type: String, default: null, index: true },

  ownerId: { type: String, default: null, index: true },
  timezone: String,
  teamMemberIds: { type: [String], default: [], index: true },
  recruiterId: { type: String, default: null },
  nextDueDate: { type: String, default: null, index: true },
  riskFlags: { type: [String], default: [] },

  payrollMapping: {
    provider: { type: String, enum: ["gusto"] },
    companyRef: String,
    employeeId: String,
    paySchedule: String,
    payType: String,
    mappedAt: Date,
    mappedBy: String,
  },

  source: String,
  stage: { type: String, enum: CANDIDATE_STAGES, default: "new", index: true },
  priority: { type: String, enum: ["low", "normal", "high", "urgent"], default: "normal" },
  tags: { type: [String], default: [], index: true },
  notes: {
    type: [
      {
        _id: { type: String, required: true },
        text: { type: String, required: true },
        authorId: { type: String, required: true },
        authorName: String,
        createdAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },
  contactHistory: {
    type: [
      {
        _id: { type: String, required: true },
        channel: { type: String, enum: ["call", "email", "meeting", "message", "other"], default: "other" },
        summary: { type: String, required: true },
        byId: { type: String, required: true },
        byName: String,
        at: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },
  nameDobHash: { type: String, index: true },
  createdBy: String,
  updatedBy: String,
});

// Duplicate prevention at the database level (AC-01): one candidate per email and per SEVIS ID.
schema.index({ emailLower: 1 }, { unique: true });
schema.index({ sevisHash: 1 }, { unique: true, partialFilterExpression: { sevisHash: { $type: "string" } } });
schema.index({ legalName: "text", emailLower: "text", candidateCode: "text", school: "text" });

export const Candidate = model<ICandidate>("Candidate", schema, "candidates");
