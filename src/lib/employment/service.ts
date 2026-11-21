import { connectDb } from "@/lib/db/connect";
import { Candidate } from "@/lib/db/models/candidate";
import { Employer, EmploymentRecord, type IEmployer, type IEmploymentRecord } from "@/lib/db/models/employer";
import { audit } from "@/lib/audit";
import { assertCan, can, type Actor } from "@/lib/rbac/can";
import type { SessionUser } from "@/lib/auth/session";
import { raiseChangeReview, regenerateComplianceSchedule } from "@/lib/tasks/triggers";
import { ImmigrationError, requireCandidate } from "@/lib/immigration/access";
import { changedMaterialFields } from "./changes";
import type { EmploymentInput } from "./schema";

/**
 * Employment records are OPERATIONAL data (who the candidate works for, hours, duties). They never grant clearance:
 * edits only raise review tasks and re-run the clearance guard, which can revoke but never grant.
 */

/** Compensation detail is restricted: visible with payroll.amounts.view or candidates.edit. */
export const canSeePayTerms = (actor: Actor) => can(actor, "payroll.amounts.view") || can(actor, "candidates.edit");

export interface EmploymentView {
  id: string;
  employerId: string;
  employerName?: string;
  jobTitle?: string;
  jobDuties?: string;
  supervisor?: IEmploymentRecord["supervisor"];
  worksiteName?: string;
  worksiteAddress?: string;
  startDate?: string;
  endDate?: string | null;
  hoursPerWeek?: number;
  payTerms?: string; // present only for permitted actors
  relatedToDegree?: IEmploymentRecord["relatedToDegree"];
  relationReviewNote?: string;
  status: IEmploymentRecord["status"];
  isCurrent: boolean;
}

export async function listEmployment(actor: SessionUser, candidateId: string): Promise<{ rows: EmploymentView[]; currentEmployerId?: string | null; employers: { id: string; name: string }[] }> {
  assertCan(actor, "candidates.view");
  const candidate = await requireCandidate(actor, candidateId);
  await connectDb();
  const [records, employers] = await Promise.all([
    EmploymentRecord.find({ candidateId }).sort({ status: 1, startDate: -1 }).lean<IEmploymentRecord[]>(),
    Employer.find({}).select("legalName").sort({ legalNameLower: 1 }).limit(500).lean<IEmployer[]>(),
  ]);
  const name = new Map(employers.map((e) => [e._id, e.legalName]));
  const showPay = canSeePayTerms(actor);
  if (showPay && records.some((r) => r.payTerms)) {
    await audit({ actor, action: "read", entityType: "employment_pay_terms", candidateId, summary: "Viewed employment pay terms" });
  }
  return {
    currentEmployerId: candidate.currentEmployerId,
    employers: employers.map((e) => ({ id: e._id, name: e.legalName })),
    rows: records.map((r) => ({
      id: r._id,
      employerId: r.employerId,
      employerName: name.get(r.employerId),
      jobTitle: r.jobTitle,
      jobDuties: r.jobDuties,
      supervisor: r.supervisor,
      worksiteName: r.worksiteName,
      worksiteAddress: r.worksiteAddress,
      startDate: r.startDate,
      endDate: r.endDate,
      hoursPerWeek: r.hoursPerWeek,
      payTerms: showPay ? r.payTerms : undefined,
      relatedToDegree: r.relatedToDegree,
      relationReviewNote: r.relationReviewNote,
      status: r.status,
      isCurrent: candidate.currentEmployerId === r.employerId && r.status === "active",
    })),
  };
}

function toFields(input: EmploymentInput) {
  return {
    employerId: input.employerId,
    jobTitle: input.jobTitle,
    jobDuties: input.jobDuties,
    supervisor: { name: input.supervisorName, email: input.supervisorEmail, phone: input.supervisorPhone },
    worksiteName: input.worksiteName,
    worksiteAddress: input.worksiteAddress,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    hoursPerWeek: input.hoursPerWeek,
    payTerms: input.payTerms,
    relatedToDegree: input.relatedToDegree,
    relationReviewNote: input.relationReviewNote,
    status: input.endDate ? ("ended" as const) : ("active" as const),
  };
}

const snap = (r: Partial<IEmploymentRecord>) => ({
  employerId: r.employerId, jobTitle: r.jobTitle, jobDuties: r.jobDuties, worksiteName: r.worksiteName,
  worksiteAddress: r.worksiteAddress, hoursPerWeek: r.hoursPerWeek, payTerms: r.payTerms,
});
/** Audit shape never includes compensation detail. */
const auditShape = (r: Partial<IEmploymentRecord>) => ({ ...snap(r), payTerms: r.payTerms ? "[restricted]" : undefined, startDate: r.startDate, endDate: r.endDate, status: r.status, relatedToDegree: r.relatedToDegree });

async function assertEmployer(employerId: string) {
  await connectDb();
  if (!(await Employer.exists({ _id: employerId }))) throw new ImmigrationError("Selected employer was not found.");
}

export async function createEmployment(actor: SessionUser, candidateId: string, input: EmploymentInput) {
  assertCan(actor, "candidates.edit");
  const candidate = await requireCandidate(actor, candidateId);
  await assertEmployer(input.employerId);
  const hadRecords = (await EmploymentRecord.countDocuments({ candidateId })) > 0;
  const created = await EmploymentRecord.create({ ...toFields(input), candidateId });
  await audit({
    actor, action: "create", entityType: "employment_record", entityId: created._id, candidateId,
    summary: `Added employment record`, after: auditShape(created.toObject()),
  });
  if (created.status === "active" && (input.setAsCurrent || !candidate.currentEmployerId)) {
    await Candidate.updateOne({ _id: candidateId }, { $set: { currentEmployerId: created.employerId, updatedBy: actor.id } });
  }
  if (hadRecords) {
    await raiseChangeReview({ actor, candidateId, fields: ["employer"], summary: "A new employment record was added for a candidate with prior employment — review whether the employer change must be reported (confirm with DSO)." });
  }
  await regenerateComplianceSchedule({ actor, candidateId });
}

export async function updateEmployment(actor: SessionUser, candidateId: string, recordId: string, input: EmploymentInput) {
  assertCan(actor, "candidates.edit");
  const candidate = await requireCandidate(actor, candidateId);
  await assertEmployer(input.employerId);
  const rec = await EmploymentRecord.findOne({ _id: recordId, candidateId });
  if (!rec) throw new ImmigrationError("Employment record not found.");
  const before = rec.toObject() as IEmploymentRecord;
  rec.set(toFields(input));
  await rec.save();
  const after = rec.toObject() as IEmploymentRecord;
  const { fields, labels } = changedMaterialFields(snap(before), snap(after));
  await audit({
    actor, action: "update", entityType: "employment_record", entityId: recordId, candidateId,
    summary: labels.length ? `Updated employment record (changed: ${labels.join(", ")})` : "Updated employment record",
    before: auditShape(before), after: auditShape(after),
  });
  if (input.setAsCurrent && after.status === "active" && candidate.currentEmployerId !== after.employerId) {
    await Candidate.updateOne({ _id: candidateId }, { $set: { currentEmployerId: after.employerId, updatedBy: actor.id } });
  }
  if (fields.length) {
    await raiseChangeReview({ actor, candidateId, fields, summary: `Employment record updated: ${labels.join(", ")} changed — review whether DSO / I-983 reporting is needed.` });
  }
  await regenerateComplianceSchedule({ actor, candidateId });
}

export async function endEmployment(actor: SessionUser, candidateId: string, recordId: string, endDate: string) {
  assertCan(actor, "candidates.edit");
  const candidate = await requireCandidate(actor, candidateId);
  const rec = await EmploymentRecord.findOne({ _id: recordId, candidateId });
  if (!rec) throw new ImmigrationError("Employment record not found.");
  if (rec.status === "ended") throw new ImmigrationError("This employment record is already ended.");
  if (rec.startDate && endDate < rec.startDate) throw new ImmigrationError("End date cannot be before the start date.");
  rec.status = "ended";
  rec.endDate = endDate;
  await rec.save();
  if (candidate.currentEmployerId === rec.employerId) {
    await Candidate.updateOne({ _id: candidateId }, { $set: { currentEmployerId: null, updatedBy: actor.id } });
  }
  await audit({ actor, action: "status_change", entityType: "employment_record", entityId: recordId, candidateId, summary: `Ended employment on ${endDate}`, after: { status: "ended", endDate } });
  await raiseChangeReview({ actor, candidateId, fields: ["employer"], summary: `Employment ended on ${endDate} — review whether the end of employment must be reported and track unemployment days (confirm with DSO).` });
  await regenerateComplianceSchedule({ actor, candidateId });
}

export async function setCurrentEmployer(actor: SessionUser, candidateId: string, employerId: string | null) {
  assertCan(actor, "candidates.edit");
  const candidate = await requireCandidate(actor, candidateId);
  if (employerId) await assertEmployer(employerId);
  const previous = candidate.currentEmployerId ?? null;
  if (previous === employerId) return;
  await Candidate.updateOne({ _id: candidateId }, { $set: { currentEmployerId: employerId, updatedBy: actor.id } });
  await audit({
    actor, action: "update", entityType: "candidate", entityId: candidateId, candidateId,
    summary: employerId ? "Changed current employer" : "Cleared current employer", before: { currentEmployerId: previous }, after: { currentEmployerId: employerId },
  });
  if (previous && employerId) {
    await raiseChangeReview({ actor, candidateId, fields: ["employer"], summary: "Current employer changed — review whether the change must be reported (confirm with DSO)." });
  }
  await regenerateComplianceSchedule({ actor, candidateId });
}
