import { connectDb } from "@/lib/db/connect";
import { UnemploymentPeriod } from "@/lib/db/models/immigration-extra";
import { audit } from "@/lib/audit";
import { assertCan, can } from "@/lib/rbac/can";
import type { SessionUser } from "@/lib/auth/session";
import { refreshRiskFlags } from "./flags";
import { todayFor } from "./calendar";
import { ImmigrationError, requireCandidate } from "./access";
import type { UnemploymentInput } from "./schema";

/**
 * Unemployment periods are MANUAL input (never inferred from payroll). Entered by someone holding `immigration.verify`
 * they are stamped verified; otherwise they stay "unverified" until a verifier confirms them.
 */
export async function addUnemployment(actor: SessionUser, candidateId: string, input: UnemploymentInput) {
  assertCan(actor, "immigration.edit");
  await requireCandidate(actor, candidateId);
  await connectDb();
  const verified = can(actor, "immigration.verify");
  const row = await UnemploymentPeriod.create({
    candidateId,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    notes: input.notes,
    verifiedBy: verified ? actor.id : null,
    verifiedAt: verified ? new Date() : null,
    createdBy: actor.id,
  });
  await audit({
    actor, action: "create", entityType: "unemployment_period", entityId: row._id, candidateId,
    summary: `Recorded unemployment period ${input.startDate} to ${input.endDate ?? "ongoing"}${verified ? " (verified)" : " (unverified)"}`,
  });
  await refreshRiskFlags(candidateId, todayFor(actor));
}

export async function verifyUnemployment(actor: SessionUser, candidateId: string, periodId: string) {
  assertCan(actor, "immigration.verify");
  await requireCandidate(actor, candidateId);
  const row = await UnemploymentPeriod.findOne({ _id: periodId, candidateId });
  if (!row) throw new ImmigrationError("Unemployment period not found.");
  row.verifiedBy = actor.id;
  row.verifiedAt = new Date();
  await row.save();
  await audit({ actor, action: "approve", entityType: "unemployment_period", entityId: periodId, candidateId, summary: "Verified unemployment period" });
}

export async function deleteUnemployment(actor: SessionUser, candidateId: string, periodId: string) {
  assertCan(actor, "immigration.edit");
  await requireCandidate(actor, candidateId);
  const row = await UnemploymentPeriod.findOneAndDelete({ _id: periodId, candidateId });
  if (!row) throw new ImmigrationError("Unemployment period not found.");
  await audit({
    actor, action: "delete", entityType: "unemployment_period", entityId: periodId, candidateId,
    summary: `Deleted unemployment period ${row.startDate} to ${row.endDate ?? "ongoing"}`,
  });
  await refreshRiskFlags(candidateId, todayFor(actor));
}
