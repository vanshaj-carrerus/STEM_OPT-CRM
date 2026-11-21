import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/rbac/can";
import { loadCandidateFor } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { PayrollError } from "./errors";
import { logSync } from "./sync-log";

/**
 * Candidate ↔ Gusto employee mapping. Explicit, audited, stored on `Candidate.payrollMapping`; a candidate is never
 * assumed to be a payroll employee. Only provider IDs are stored — never tax identifiers or bank details.
 */
const SSN_LIKE = /^\d{3}-?\d{2}-?\d{4}$/;
const REF = /^[A-Za-z0-9._-]{1,64}$/;

export const mappingSchema = z.object({
  candidateId: z.string().min(1),
  employeeId: z
    .string()
    .trim()
    .regex(REF, "Use the Gusto employee ID/UUID (letters, numbers, dot, dash, underscore; max 64).")
    .refine((v) => !SSN_LIKE.test(v), "That looks like a tax identifier. Enter the Gusto employee ID instead."),
  companyRef: z.string().trim().regex(REF, "Invalid company reference.").optional().or(z.literal("")),
  paySchedule: z.string().trim().max(60).optional().or(z.literal("")),
  payType: z.enum(["hourly", "salary", "stipend", "other"]).optional().or(z.literal("")),
});
export type MappingInput = z.input<typeof mappingSchema>;

export async function updatePayrollMapping(actor: SessionUser, raw: MappingInput) {
  assertCan(actor, "payroll.prepare");
  const input = mappingSchema.parse(raw);
  const candidate = await loadCandidateFor(actor, input.candidateId);
  if (!candidate) throw new PayrollError("Candidate not found.", 404);
  await connectDb();
  const gusto = await getSetting("integrations.gusto");
  const companyRef = input.companyRef || gusto.companyRef || undefined;

  const dup = await Candidate.findOne({
    _id: { $ne: input.candidateId },
    "payrollMapping.employeeId": input.employeeId,
    "payrollMapping.companyRef": companyRef ?? null,
  })
    .select("candidateCode")
    .lean<ICandidate>();
  if (dup) throw new PayrollError(`That Gusto employee ID is already mapped to candidate ${dup.candidateCode}.`, 409, "duplicate_mapping");

  const before = candidate.payrollMapping ?? null;
  const mapping = {
    provider: "gusto" as const,
    companyRef,
    employeeId: input.employeeId,
    paySchedule: input.paySchedule || undefined,
    payType: input.payType || undefined,
    mappedAt: new Date(),
    mappedBy: actor.id,
  };
  await Candidate.updateOne({ _id: input.candidateId }, { $set: { payrollMapping: mapping, updatedBy: actor.id } });
  await audit({
    actor, action: "update", entityType: "payroll_mapping", entityId: input.candidateId, candidateId: input.candidateId,
    summary: before?.employeeId ? "Changed Gusto employee mapping" : "Mapped candidate to Gusto employee",
    before: before ? { employeeId: before.employeeId, companyRef: before.companyRef, payType: before.payType } : null,
    after: { employeeId: mapping.employeeId, companyRef: mapping.companyRef, payType: mapping.payType },
  });
  await logSync({ kind: "mapping", message: `${before?.employeeId ? "Changed" : "Created"} Gusto mapping for candidate ${candidate.candidateCode}`, actorId: actor.id });
}

export async function clearPayrollMapping(actor: SessionUser, candidateId: string, reason: string) {
  assertCan(actor, "payroll.prepare");
  const why = z.string().trim().min(5, "A reason (min 5 characters) is required.").max(500).parse(reason);
  const candidate = await loadCandidateFor(actor, candidateId);
  if (!candidate) throw new PayrollError("Candidate not found.", 404);
  if (!candidate.payrollMapping?.employeeId) return;
  await Candidate.updateOne({ _id: candidateId }, { $unset: { payrollMapping: "" }, $set: { updatedBy: actor.id } });
  await audit({
    actor, action: "update", entityType: "payroll_mapping", entityId: candidateId, candidateId,
    summary: "Removed Gusto employee mapping", reason: why, before: { employeeId: candidate.payrollMapping.employeeId },
  });
  await logSync({ kind: "mapping", message: `Removed Gusto mapping for candidate ${candidate.candidateCode}`, actorId: actor.id });
}
