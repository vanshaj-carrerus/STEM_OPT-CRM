import { z } from "zod";
import { compareDates, isDateOnly } from "@/lib/compliance/dates";
import { I983_STATUSES } from "@/lib/candidates/constants";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optStr = (max = 200) => z.preprocess(blank, z.string().trim().max(max).optional());
const reqDate = (label: string) =>
  z.string({ error: `${label} is required` }).trim().refine((v) => isDateOnly(v), `${label}: use a valid date (YYYY-MM-DD)`);
const optDate = (label: string) => z.preprocess(blank, z.string().trim().refine((v) => isDateOnly(v), `${label}: use a valid date (YYYY-MM-DD)`).optional());

export const AUTH_PERIOD_TYPES = ["CPT", "OPT", "STEM_OPT"] as const;

export const authorizationPeriodSchema = z
  .object({
    type: z.enum(AUTH_PERIOD_TYPES, { error: "Choose CPT, OPT or STEM OPT" }),
    category: optStr(20), // EAD category e.g. C03B / C03C
    startDate: reqDate("Start date"),
    endDate: reqDate("End date"),
    employerId: optStr(64),
    workTime: z.preprocess(blank, z.enum(["full", "part"]).optional()),
    educationLevel: optStr(60),
    evidenceDocumentId: optStr(64),
    notes: optStr(2000),
  })
  .superRefine((v, ctx) => {
    if (v.startDate && v.endDate && isDateOnly(v.startDate) && isDateOnly(v.endDate) && compareDates(v.endDate, v.startDate) < 0) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be on or after the start date" });
    }
    if (v.type === "CPT") {
      if (!v.employerId) ctx.addIssue({ code: "custom", path: ["employerId"], message: "CPT is employer-specific: choose the employer" });
      if (!v.workTime) ctx.addIssue({ code: "custom", path: ["workTime"], message: "Record full-time or part-time" });
    }
  });
export type AuthorizationPeriodInput = z.infer<typeof authorizationPeriodSchema>;

export const i983Schema = z.object({
  status: z.enum(I983_STATUSES),
  formVersion: optStr(60),
  studentSignedOn: optDate("Student signature date"),
  employerSignedOn: optDate("Employer signature date"),
  dsoSubmittedOn: optDate("DSO submission date"),
  trainingPlanSummary: optStr(4000),
  evidenceDocumentId: optStr(64),
});
export type I983Input = z.infer<typeof i983Schema>;

export const unemploymentSchema = z
  .object({
    startDate: reqDate("Start date"),
    endDate: optDate("End date"),
    notes: optStr(1000),
  })
  .superRefine((v, ctx) => {
    if (v.endDate && isDateOnly(v.startDate) && compareDates(v.endDate, v.startDate) < 0) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be on or after the start date" });
    }
  });
export type UnemploymentInput = z.infer<typeof unemploymentSchema>;

export const idSchema = z.string().trim().min(1).max(64);
export const reasonSchema = z.string().trim().min(3, "Enter a reason").max(500);
