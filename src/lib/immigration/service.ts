import { connectDb } from "@/lib/db/connect";
import { AuthorizationPeriod, Employer, type IAuthorizationPeriod } from "@/lib/db/models/employer";
import { I983Record } from "@/lib/db/models/immigration-extra";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/rbac/can";
import type { SessionUser } from "@/lib/auth/session";
import { regenerateSchedule } from "./schedule";
import { getEvidenceDoc, isDocVerified } from "./evidence";
import { ImmigrationError, requireCandidate } from "./access";
import type { AuthorizationPeriodInput } from "./schema";

/**
 * Authorization period lifecycle (CPT segments, OPT, STEM OPT). The CRM records dates and evidence and raises tasks;
 * decisions stay with the official documents, the DSO and counsel. Nothing is ever submitted to SEVIS/DSO.
 */

/** Fields whose change invalidates a previous verification (dates, type, employer, evidence). */
const VERIFICATION_FIELDS = ["type", "startDate", "endDate", "employerId", "evidenceDocumentId"] as const;

const auditShape = (p: Partial<IAuthorizationPeriod>) => ({
  type: p.type, category: p.category, startDate: p.startDate, endDate: p.endDate, employerId: p.employerId,
  fullTime: p.fullTime, educationLevel: p.educationLevel, evidenceDocumentId: p.evidenceDocumentId, verification: p.verification,
});

async function validateRefs(candidateId: string, input: AuthorizationPeriodInput) {
  await connectDb();
  if (input.employerId && !(await Employer.exists({ _id: input.employerId }))) throw new ImmigrationError("Selected employer was not found.");
  if (input.evidenceDocumentId && !(await getEvidenceDoc(candidateId, input.evidenceDocumentId))) {
    throw new ImmigrationError("Selected evidence document was not found on this candidate.");
  }
}

function toFields(input: AuthorizationPeriodInput) {
  return {
    type: input.type,
    category: input.category ?? undefined,
    startDate: input.startDate,
    endDate: input.endDate,
    employerId: input.employerId ?? null,
    fullTime: input.type === "CPT" ? input.workTime === "full" : undefined,
    educationLevel: input.educationLevel ?? undefined,
    evidenceDocumentId: input.evidenceDocumentId ?? null,
    notes: input.notes ?? undefined,
  };
}

export async function createPeriod(actor: SessionUser, candidateId: string, input: AuthorizationPeriodInput) {
  assertCan(actor, "immigration.edit");
  await requireCandidate(actor, candidateId);
  await validateRefs(candidateId, input);
  const created = await AuthorizationPeriod.create({ ...toFields(input), candidateId, verification: "unverified", createdBy: actor.id });
  await audit({
    actor, action: "create", entityType: "authorization_period", entityId: created._id, candidateId,
    summary: `Added ${input.type} period ${input.startDate} to ${input.endDate} (unverified)`, after: auditShape(created.toObject()),
  });
  await regenerateSchedule({ actor, candidateId });
  return created.toObject() as IAuthorizationPeriod;
}

export async function updatePeriod(actor: SessionUser, candidateId: string, periodId: string, input: AuthorizationPeriodInput) {
  assertCan(actor, "immigration.edit");
  await requireCandidate(actor, candidateId);
  await validateRefs(candidateId, input);
  const existing = await AuthorizationPeriod.findOne({ _id: periodId, candidateId });
  if (!existing) throw new ImmigrationError("Authorization period not found.");
  const before = auditShape(existing.toObject());
  const wasVerified = existing.verification === "verified";

  existing.set(toFields(input));
  const invalidated = wasVerified && VERIFICATION_FIELDS.some((f) => existing.isModified(f));
  if (invalidated) {
    existing.verification = "unverified";
    existing.verifiedBy = null;
    existing.verifiedAt = null;
  }
  await existing.save();

  await audit({
    actor, action: "update", entityType: "authorization_period", entityId: periodId, candidateId,
    summary: invalidated
      ? "Edited verified authorization period: dates/evidence changed, verification reset to unverified"
      : "Edited authorization period",
    before, after: auditShape(existing.toObject()),
  });
  if (invalidated) {
    await I983Record.updateOne({ authorizationPeriodId: periodId }, { $set: { verification: "unverified", verifiedBy: null, verifiedAt: null } });
  }
  await regenerateSchedule({ actor, candidateId });
  return existing.toObject() as IAuthorizationPeriod;
}

/** Only never-verified periods can be deleted; verified history must be un-verified / rejected first so it stays auditable. */
export async function deletePeriod(actor: SessionUser, candidateId: string, periodId: string) {
  assertCan(actor, "immigration.edit");
  await requireCandidate(actor, candidateId);
  const p = await AuthorizationPeriod.findOne({ _id: periodId, candidateId });
  if (!p) throw new ImmigrationError("Authorization period not found.");
  if (p.verification === "verified") throw new ImmigrationError("A verified period cannot be deleted. Un-verify or reject it first (with a reason).");
  await p.deleteOne();
  await I983Record.deleteMany({ authorizationPeriodId: periodId });
  await audit({
    actor, action: "delete", entityType: "authorization_period", entityId: periodId, candidateId,
    summary: `Deleted ${p.type} period ${p.startDate} to ${p.endDate}`, before: auditShape(p.toObject()),
  });
  await regenerateSchedule({ actor, candidateId });
}

/** Verify: requires `immigration.verify` AND an attached evidence document that is itself verified. */
export async function verifyPeriod(actor: SessionUser, candidateId: string, periodId: string) {
  assertCan(actor, "immigration.verify");
  await requireCandidate(actor, candidateId);
  const p = await AuthorizationPeriod.findOne({ _id: periodId, candidateId });
  if (!p) throw new ImmigrationError("Authorization period not found.");
  if (!p.evidenceDocumentId) throw new ImmigrationError("Attach the evidence document (endorsed I-20 or EAD card) before verifying.");
  const doc = await getEvidenceDoc(candidateId, p.evidenceDocumentId);
  if (!isDocVerified(doc)) throw new ImmigrationError("The evidence document must be verified in the Documents tab before the dates can be verified.");
  if (p.type === "CPT" && !p.employerId) throw new ImmigrationError("CPT periods must be linked to an employer.");
  p.verification = "verified";
  p.verifiedBy = actor.id;
  p.verifiedAt = new Date();
  await p.save();
  await audit({
    actor, action: "approve", entityType: "authorization_period", entityId: periodId, candidateId,
    summary: `Verified ${p.type} dates ${p.startDate} to ${p.endDate} against evidence`, after: auditShape(p.toObject()),
  });
  await regenerateSchedule({ actor, candidateId });
}

/** Un-verify or reject a period (reason required). Cancels derived milestones and revokes dependent clearance. */
export async function unverifyPeriod(actor: SessionUser, candidateId: string, periodId: string, reason: string, as: "unverified" | "rejected" = "unverified") {
  assertCan(actor, "immigration.verify");
  await requireCandidate(actor, candidateId);
  const p = await AuthorizationPeriod.findOne({ _id: periodId, candidateId });
  if (!p) throw new ImmigrationError("Authorization period not found.");
  const before = auditShape(p.toObject());
  p.verification = as;
  p.verifiedBy = null;
  p.verifiedAt = null;
  await p.save();
  await I983Record.updateOne({ authorizationPeriodId: periodId }, { $set: { verification: "unverified", verifiedBy: null, verifiedAt: null } });
  await audit({
    actor, action: as === "rejected" ? "reject" : "status_change", entityType: "authorization_period", entityId: periodId, candidateId,
    summary: `${as === "rejected" ? "Rejected" : "Un-verified"} ${p.type} period ${p.startDate} to ${p.endDate}`,
    reason, before, after: auditShape(p.toObject()),
  });
  await regenerateSchedule({ actor, candidateId });
}
