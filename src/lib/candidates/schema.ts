import { z } from "zod";
import { isDateOnly } from "@/lib/compliance/dates";
import { AUTH_TYPES, CANDIDATE_STAGES, I983_STATUSES } from "@/lib/db/models/candidate";

const optStr = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === "" ? undefined : v));

const optDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .refine((v) => v === undefined || isDateOnly(v), "Use a valid date (YYYY-MM-DD)");

const optEmail = z
  .string()
  .trim()
  .toLowerCase()
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .refine((v) => v === undefined || z.string().email().safeParse(v).success, "Invalid email");

/** A date of birth must be a real past date (1900 or later) — protects the encrypted DOB and the duplicate hash from junk. */
const optDob = optDate.refine(
  (v) => v === undefined || (v >= "1900-01-01" && v <= new Date().toISOString().slice(0, 10)),
  "Date of birth must be between 1900 and today",
);

/** Fields grouped by the permission needed to edit them. */
export const identityShape = {
  legalName: z.string().trim().min(2, "Legal name is required").max(160),
  preferredName: optStr(100),
  email: z.string().trim().toLowerCase().email("Valid email required"),
  phone: optStr(40),
  dateOfBirth: optDob, // protected (needs sensitive.dob.view)
  addressLine1: optStr(160),
  addressLine2: optStr(160),
  city: optStr(80),
  state: optStr(80),
  postalCode: optStr(20),
  addressCountry: optStr(80),
  country: optStr(80),
  emergencyName: optStr(120),
  emergencyPhone: optStr(40),
  emergencyRelationship: optStr(60),
};

export const educationShape = {
  school: optStr(160),
  campus: optStr(120),
  degreeLevel: optStr(60),
  degree: optStr(120),
  major: optStr(120),
  stemCipCode: optStr(20),
  programStart: optDate,
  programEnd: optDate,
  graduationDate: optDate,
  dsoName: optStr(120),
  dsoEmail: optEmail,
  dsoPhone: optStr(40),
};

export const immigrationShape = {
  sevisId: optStr(30), // protected
  visaStatus: optStr(40),
  authType: z.enum(AUTH_TYPES).optional(),
  eadCategory: optStr(20),
  eadNumber: optStr(30), // protected
  eadStart: optDate,
  eadEnd: optDate,
  i20IssueDate: optDate,
  i20EndorsementDate: optDate,
  receiptNumber: optStr(30),
  caseStatus: optStr(80),
  i983Status: z.enum(I983_STATUSES).optional(),
  validationStatus: optStr(80),
  reviewOutcome: optStr(200),
};

export const crmShape = {
  stage: z.enum(CANDIDATE_STAGES).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  source: optStr(80),
  tagsCsv: optStr(300),
  ownerId: optStr(60),
  recruiterId: optStr(60),
};

const base = z.object({ ...identityShape, ...educationShape, ...immigrationShape, ...crmShape });

function dateOrder(v: { eadStart?: string; eadEnd?: string; programStart?: string; programEnd?: string }, ctx: z.RefinementCtx) {
  if (v.eadStart && v.eadEnd && v.eadEnd < v.eadStart) {
    ctx.addIssue({ code: "custom", path: ["eadEnd"], message: "EAD end must be on/after EAD start" });
  }
  if (v.programStart && v.programEnd && v.programEnd < v.programStart) {
    ctx.addIssue({ code: "custom", path: ["programEnd"], message: "Program end must be on/after start" });
  }
}

/** Create: sensible defaults for stage/priority/authorization. */
export const candidateCreateSchema = base
  .extend({
    authType: z.enum(AUTH_TYPES).default("none"),
    i983Status: z.enum(I983_STATUSES).default("not_applicable"),
    stage: z.enum(CANDIDATE_STAGES).default("new"),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  })
  .superRefine(dateOrder);

/** Update/PATCH: every field optional and NO defaults, so omitted fields are never reset. */
export const candidatePatchSchema = base.partial().superRefine(dateOrder);

export type CandidateInput = z.infer<typeof candidateCreateSchema>;
export type CandidatePatch = z.infer<typeof candidatePatchSchema>;

/** Which input keys require which edit permission (everything else = candidates.edit). */
export const IMMIGRATION_KEYS = Object.keys(immigrationShape) as (keyof CandidateInput)[];
export const SENSITIVE_KEYS = {
  sevisId: "sensitive.sevis.view",
  eadNumber: "sensitive.ead.view",
  dateOfBirth: "sensitive.dob.view",
} as const;
