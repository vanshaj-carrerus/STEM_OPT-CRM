import { z } from "zod";
import { compareDates, isDateOnly } from "@/lib/compliance/dates";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optStr = (max = 200) => z.preprocess(blank, z.string().trim().max(max).optional());
const optDate = (label: string) => z.preprocess(blank, z.string().trim().refine((v) => isDateOnly(v), `${label}: use a valid date (YYYY-MM-DD)`).optional());
const optEmail = z.preprocess(blank, z.string().trim().toLowerCase().email("Invalid email").optional());

export const employmentSchema = z
  .object({
    employerId: z.string().trim().min(1, "Choose an employer").max(64),
    jobTitle: optStr(120),
    jobDuties: optStr(4000),
    supervisorName: optStr(120),
    supervisorEmail: optEmail,
    supervisorPhone: optStr(40),
    worksiteName: optStr(160),
    worksiteAddress: optStr(300),
    startDate: optDate("Start date"),
    endDate: optDate("End date"),
    hoursPerWeek: z.preprocess(blank, z.coerce.number({ error: "Enter a number" }).min(0).max(80).optional()),
    payTerms: optStr(500),
    relatedToDegree: z.enum(["yes", "no", "needs_review"]).default("needs_review"),
    relationReviewNote: optStr(1000),
    setAsCurrent: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
  })
  .superRefine((v, ctx) => {
    if (v.startDate && v.endDate && compareDates(v.endDate, v.startDate) < 0) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be on or after the start date" });
    }
  });
export type EmploymentInput = z.infer<typeof employmentSchema>;

export const endEmploymentSchema = z.object({
  endDate: z.string().trim().refine((v) => isDateOnly(v), "Use a valid date (YYYY-MM-DD)"),
});
