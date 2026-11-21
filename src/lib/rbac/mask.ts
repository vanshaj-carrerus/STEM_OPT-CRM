import { can, type Actor } from "./can";
import type { Permission } from "./permissions";

/**
 * Field-level serializer. For each restricted field we declare the permission required to see it;
 * without it the field is removed entirely (not just blanked) from the API/UI payload.
 */
export type FieldRules = Record<string, Permission>;

export function stripRestricted<T extends Record<string, unknown>>(actor: Actor, obj: T, rules: FieldRules): Partial<T> {
  const out: Record<string, unknown> = { ...obj };
  for (const [field, perm] of Object.entries(rules)) {
    if (!can(actor, perm)) delete out[field];
  }
  return out as Partial<T>;
}

/** Candidate restricted-field rules (long spec §4 / §9). Protected fields carry only a mask unless revealed. */
export const CANDIDATE_FIELD_RULES: FieldRules = {
  sevisId: "sensitive.sevis.view",
  eadNumber: "sensitive.ead.view",
  dateOfBirth: "sensitive.dob.view",
  dsoName: "immigration.view",
  dsoEmail: "immigration.view",
  dsoPhone: "immigration.view",
  receiptNumber: "immigration.view",
  // Gusto employee mapping is payroll data; case notes and contact history are compliance working papers.
  payrollMapping: "payroll.view",
  notes: "immigration.view",
  contactHistory: "immigration.view",
};

export const EMPLOYER_FIELD_RULES: FieldRules = {
  ein: "sensitive.employerIds.view",
  everifyCompanyId: "sensitive.employerIds.view",
};

export const PAYROLL_FIELD_RULES: FieldRules = {
  grossPay: "payroll.amounts.view",
  netPay: "payroll.amounts.view",
  payRate: "payroll.amounts.view",
  totals: "payroll.amounts.view",
};

export const PAYMENT_FIELD_RULES: FieldRules = {
  recipientDestination: "payments.destination.view",
};
