import { connectDb } from "@/lib/db/connect";
import { AuthorizationPeriod } from "@/lib/db/models/employer";
import { Candidate } from "@/lib/db/models/candidate";
import { I983Record, type II983Record } from "@/lib/db/models/immigration-extra";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/rbac/can";
import type { SessionUser } from "@/lib/auth/session";
import { raiseChangeReview } from "@/lib/tasks/triggers";
import { regenerateSchedule } from "./schedule";
import { getEvidenceDoc, isDocVerified } from "./evidence";
import { ImmigrationError, requireCandidate } from "./access";
import type { I983Input } from "./schema";

/** Content fields: editing any of them after verification resets the verification. */
const CONTENT: (keyof II983Record)[] = ["status", "formVersion", "studentSignedOn", "employerSignedOn", "dsoSubmittedOn", "trainingPlanSummary", "evidenceDocumentId"];
const PLAN_FIELDS: (keyof II983Record)[] = ["formVersion", "trainingPlanSummary"];

async function stemPeriod(candidateId: string, periodId: string) {
  await connectDb();
  const p = await AuthorizationPeriod.findOne({ _id: periodId, candidateId }).lean<{ type: string }>();
  if (!p) throw new ImmigrationError("Authorization period not found.");
  if (p.type !== "STEM_OPT") throw new ImmigrationError("Form I-983 applies to STEM OPT periods only.");
}

/** Record Form I-983 version / signatures / training-plan details. A changed plan or form version raises a review task (AC-06). */
export async function saveI983(actor: SessionUser, candidateId: string, periodId: string, input: I983Input) {
  assertCan(actor, "immigration.edit");
  await requireCandidate(actor, candidateId);
  await stemPeriod(candidateId, periodId);
  if (input.evidenceDocumentId && !(await getEvidenceDoc(candidateId, input.evidenceDocumentId))) {
    throw new ImmigrationError("Selected evidence document was not found on this candidate.");
  }
  const existing = await I983Record.findOne({ authorizationPeriodId: periodId });
  const next = {
    status: input.status,
    formVersion: input.formVersion,
    studentSignedOn: input.studentSignedOn,
    employerSignedOn: input.employerSignedOn,
    dsoSubmittedOn: input.dsoSubmittedOn,
    trainingPlanSummary: input.trainingPlanSummary,
    evidenceDocumentId: input.evidenceDocumentId ?? null,
  };
  const rec = existing ?? new I983Record({ candidateId, authorizationPeriodId: periodId });
  const planChanged = !!existing && PLAN_FIELDS.some((f) => (existing.get(f) ?? "") !== ((next as Record<string, unknown>)[f] ?? ""));
  const wasVerified = rec.verification === "verified";
  rec.set({ ...next, updatedBy: actor.id });
  const invalidated = wasVerified && CONTENT.some((f) => rec.isModified(f as string));
  if (invalidated) {
    rec.verification = "unverified";
    rec.verifiedBy = null;
    rec.verifiedAt = null;
  }
  await rec.save();
  await Candidate.updateOne({ _id: candidateId }, { $set: { i983Status: input.status, updatedBy: actor.id } });
  await audit({
    actor, action: existing ? "update" : "create", entityType: "i983", entityId: rec._id, candidateId,
    summary: invalidated ? "Edited verified I-983 details: verification reset" : `Saved Form I-983 details (${input.status})`,
    after: { ...next },
  });
  if (planChanged) {
    await raiseChangeReview({ actor, candidateId, fields: ["trainingPlan"], summary: "Form I-983 training plan / form version was changed — review whether the DSO must be notified or a new I-983 is needed." });
  }
  await regenerateSchedule({ actor, candidateId });
}

/** Verify the I-983: needs `immigration.verify`, signed status with both signature dates, and a verified evidence document. */
export async function verifyI983(actor: SessionUser, candidateId: string, periodId: string) {
  assertCan(actor, "immigration.verify");
  await requireCandidate(actor, candidateId);
  await stemPeriod(candidateId, periodId);
  const rec = await I983Record.findOne({ authorizationPeriodId: periodId });
  if (!rec) throw new ImmigrationError("Record the I-983 details first.");
  if (!["signed", "submitted_to_dso"].includes(rec.status)) throw new ImmigrationError("The I-983 must be recorded as signed (or submitted to the DSO) before it can be verified.");
  if (!rec.studentSignedOn || !rec.employerSignedOn) throw new ImmigrationError("Both the student and employer signature dates are required.");
  if (!isDocVerified(await getEvidenceDoc(candidateId, rec.evidenceDocumentId))) {
    throw new ImmigrationError("Attach the I-983 document and have it verified in the Documents tab first.");
  }
  rec.verification = "verified";
  rec.verifiedBy = actor.id;
  rec.verifiedAt = new Date();
  await rec.save();
  await audit({ actor, action: "approve", entityType: "i983", entityId: rec._id, candidateId, summary: "Verified Form I-983 (version and signatures)" });
  await regenerateSchedule({ actor, candidateId });
}
