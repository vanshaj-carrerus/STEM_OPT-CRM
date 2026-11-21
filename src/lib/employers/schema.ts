import { z } from "zod";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optStr = (max = 200) => z.preprocess(blank, z.string().trim().max(max).optional());
const optEmail = z.preprocess(blank, z.string().trim().toLowerCase().email("Invalid email").optional());

export const MAX_CONTACTS = 3;

export const employerSchema = z.object({
  legalName: z.string().trim().min(2, "Legal name is required").max(200),
  addressLine1: optStr(160),
  addressLine2: optStr(160),
  city: optStr(80),
  state: optStr(80),
  postalCode: optStr(20),
  isClientSite: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
  notes: optStr(2000),
  // protected identifiers: blank means "keep existing" on edit; only applied for actors with sensitive.employerIds.view
  ein: z.preprocess(blank, z.string().trim().max(30).optional()),
  everifyCompanyId: z.preprocess(blank, z.string().trim().max(40).optional()),
  contacts: z
    .array(z.object({ name: optStr(120), title: optStr(120), email: optEmail, phone: optStr(40) }))
    .max(MAX_CONTACTS),
});
export type EmployerInput = z.infer<typeof employerSchema>;

/** Flat form → structured object (contact rows are posted as contact{i}Name / Title / Email / Phone). */
export function employerFormToObject(fd: FormData): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") o[k] = v;
  const contacts: Record<string, unknown>[] = [];
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const row = { name: fd.get(`contact${i}Name`), title: fd.get(`contact${i}Title`), email: fd.get(`contact${i}Email`), phone: fd.get(`contact${i}Phone`) };
    if (Object.values(row).some((v) => typeof v === "string" && v.trim())) contacts.push(row);
  }
  o.contacts = contacts;
  o.isClientSite = fd.get("isClientSite") === "on";
  return o;
}
