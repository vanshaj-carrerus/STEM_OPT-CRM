import { connectDb } from "@/lib/db/connect";
import { Employer, type IEmployer } from "@/lib/db/models/employer";
import { protectField, revealField } from "@/lib/crypto/field";
import { audit } from "@/lib/audit";
import { assertCan, can, ForbiddenError, type Actor } from "@/lib/rbac/can";
import type { SessionUser } from "@/lib/auth/session";
import type { EmployerInput } from "./schema";

export class EmployerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmployerError";
  }
}

/** Serializable employer. Protected identifiers appear as masks ONLY for actors with `sensitive.employerIds.view`. */
export interface EmployerView {
  id: string;
  legalName: string;
  address?: IEmployer["address"];
  contacts: IEmployer["contacts"];
  isClientSite: boolean;
  notes?: string;
  einMask?: string;
  everifyMask?: string;
  hasEin: boolean;
  hasEverify: boolean;
}

export function toEmployerView(actor: Actor, e: IEmployer): EmployerView {
  const seeIds = can(actor, "sensitive.employerIds.view");
  return {
    id: e._id,
    legalName: e.legalName,
    address: e.address ? { ...e.address } : undefined,
    contacts: (e.contacts ?? []).map((c) => ({ name: c.name, email: c.email, phone: c.phone, title: c.title })),
    isClientSite: e.isClientSite,
    notes: e.notes,
    einMask: seeIds ? e.ein?.mask : undefined,
    everifyMask: seeIds ? e.everifyCompanyId?.mask : undefined,
    hasEin: !!e.ein?.enc,
    hasEverify: !!e.everifyCompanyId?.enc,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function listEmployers(actor: SessionUser, q: { q?: string; page?: number; pageSize?: number }) {
  assertCan(actor, "candidates.view");
  await connectDb();
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(100, q.pageSize ?? 25);
  const filter: Record<string, unknown> = {};
  if (q.q?.trim()) filter.legalName = new RegExp(escapeRe(q.q.trim().slice(0, 80)), "i");
  const [rows, total] = await Promise.all([
    Employer.find(filter).sort({ legalNameLower: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean<IEmployer[]>(),
    Employer.countDocuments(filter),
  ]);
  return { rows: rows.map((r) => toEmployerView(actor, r)), total, page, pageSize };
}

export async function getEmployer(actor: SessionUser, id: string): Promise<EmployerView | null> {
  assertCan(actor, "candidates.view");
  await connectDb();
  const e = await Employer.findById(id).lean<IEmployer>();
  return e ? toEmployerView(actor, e) : null;
}

function toDoc(actor: Actor, input: EmployerInput) {
  const doc: Record<string, unknown> = {
    legalName: input.legalName,
    legalNameLower: input.legalName.trim().toLowerCase(),
    address: { line1: input.addressLine1, line2: input.addressLine2, city: input.city, state: input.state, postalCode: input.postalCode },
    contacts: input.contacts.map((c) => ({ name: c.name, title: c.title, email: c.email, phone: c.phone })),
    isClientSite: input.isClientSite,
    notes: input.notes,
  };
  if (can(actor, "sensitive.employerIds.view")) {
    if (input.ein) doc.ein = protectField(input.ein);
    if (input.everifyCompanyId) doc.everifyCompanyId = protectField(input.everifyCompanyId);
  }
  return doc;
}

const auditShape = (e: object) => {
  const o: Record<string, unknown> = { ...e };
  for (const k of ["ein", "everifyCompanyId"]) {
    const p = o[k] as { mask?: string } | undefined;
    if (p) o[k] = p.mask;
  }
  return o;
};

export async function createEmployer(actor: SessionUser, input: EmployerInput): Promise<string> {
  assertCan(actor, "immigration.edit");
  await connectDb();
  try {
    const created = await Employer.create(toDoc(actor, input));
    await audit({ actor, action: "create", entityType: "employer", entityId: created._id, summary: `Created employer ${created.legalName}`, after: auditShape(created.toObject()) });
    return created._id;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new EmployerError("An employer with this legal name already exists.");
    throw err;
  }
}

export async function updateEmployer(actor: SessionUser, id: string, input: EmployerInput): Promise<void> {
  assertCan(actor, "immigration.edit");
  await connectDb();
  const existing = await Employer.findById(id);
  if (!existing) throw new ForbiddenError("Employer not found.");
  const before = auditShape(existing.toObject());
  existing.set(toDoc(actor, input));
  try {
    await existing.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new EmployerError("An employer with this legal name already exists.");
    throw err;
  }
  await audit({
    actor, action: "update", entityType: "employer", entityId: id,
    summary: `Updated employer ${existing.legalName}`, before, after: auditShape(existing.toObject()),
  });
}

/** Reveal EIN / E-Verify company ID: separate permission, always audit-logged. */
export async function revealEmployerField(actor: SessionUser, id: string, field: "ein" | "everifyCompanyId"): Promise<string> {
  assertCan(actor, "sensitive.employerIds.view");
  await connectDb();
  const e = await Employer.findById(id).lean<IEmployer>();
  if (!e) throw new ForbiddenError("Employer not found.");
  const value = revealField(e[field]);
  await audit({ actor, action: "reveal_sensitive", entityType: "employer", entityId: id, summary: `Revealed employer ${field}` });
  return value ?? "";
}
