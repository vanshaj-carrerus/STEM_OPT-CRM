import { connectDb } from "@/lib/db/connect";
import { Candidate } from "@/lib/db/models/candidate";
import { audit } from "@/lib/audit";
import { assertCan, ForbiddenError } from "@/lib/rbac/can";
import type { SessionUser } from "@/lib/auth/session";
import type { DateOnly } from "@/lib/compliance/dates";
import { loadClearanceContext, type ClearanceContext } from "./context";
import { decideClearanceRevocation } from "./clearance-rules";
import { RISK } from "./flags-rules";
import { todayFor } from "./calendar";

/**
 * Clearance lifecycle. `clearedToWork` is written ONLY here:
 *  - granted by an actor holding `immigration.verify`, and only when `evaluateClearance` passes with verified evidence;
 *  - automatically revoked (audited + risk flag) when the supporting conditions stop holding.
 * No payroll / payment data is read anywhere on this path.
 */

export async function evaluateCandidateClearance(candidateId: string, today: DateOnly): Promise<ClearanceContext | null> {
  return loadClearanceContext(candidateId, today);
}

export async function grantClearance(actor: SessionUser, candidateId: string): Promise<ClearanceContext> {
  assertCan(actor, "immigration.verify");
  await connectDb();
  const ctx = await loadClearanceContext(candidateId, todayFor(actor));
  if (!ctx) throw new ForbiddenError("Candidate not found.");
  if (!ctx.evaluation.cleared || !ctx.period?.evidenceDocumentId) {
    throw new ClearanceBlockedError(ctx.evaluation.reasons);
  }
  const now = new Date();
  await Candidate.updateOne(
    { _id: candidateId },
    {
      $set: {
        clearedToWork: true,
        clearedBy: actor.id,
        clearedAt: now,
        clearedEvidenceDocId: ctx.period.evidenceDocumentId,
        updatedBy: actor.id,
      },
      $pull: { riskFlags: RISK.clearanceRevoked },
    },
  );
  await audit({
    actor,
    action: "approve",
    entityType: "clearance",
    entityId: candidateId,
    candidateId,
    summary: `Cleared to work (${ctx.period.type} ${ctx.period.startDate} to ${ctx.period.endDate}); evidence verified`,
    after: { authorizationPeriodId: ctx.period._id, evidenceDocumentId: ctx.period.evidenceDocumentId, plannedWorkStart: ctx.workRecord?.startDate },
  });
  return ctx;
}

export class ClearanceBlockedError extends Error {
  constructor(public reasons: string[]) {
    super(`Cannot clear to work: ${reasons.join(" ")}`);
    this.name = "ClearanceBlockedError";
  }
}

async function revoke(actor: SessionUser | null, candidateId: string, reasons: string[], opts: { automatic: boolean; reason?: string }) {
  await Candidate.updateOne(
    { _id: candidateId },
    {
      $set: { clearedToWork: false, clearedBy: null, clearedAt: null, clearedEvidenceDocId: null, ...(actor ? { updatedBy: actor.id } : {}) },
      ...(opts.automatic ? { $addToSet: { riskFlags: RISK.clearanceRevoked } } : {}),
    },
  );
  await audit({
    actor,
    action: "status_change",
    entityType: "clearance",
    entityId: candidateId,
    candidateId,
    source: actor ? undefined : "system",
    summary: opts.automatic ? `Clearance to work automatically revoked: ${reasons.join(" ")}` : "Clearance to work revoked manually",
    reason: opts.reason,
    before: { clearedToWork: true },
    after: { clearedToWork: false, reasons },
  });
}

/** Manual revoke (immigration.verify). */
export async function revokeClearance(actor: SessionUser, candidateId: string, reason: string) {
  assertCan(actor, "immigration.verify");
  await connectDb();
  const c = await Candidate.findById(candidateId).select("clearedToWork").lean<{ clearedToWork: boolean }>();
  if (!c?.clearedToWork) return;
  await revoke(actor, candidateId, [reason], { automatic: false, reason });
}

/**
 * Re-check an already-cleared candidate and revoke if conditions stopped holding. Safe to call from any trigger
 * (date edits, evidence un-verified, employment ended, daily worker). Never GRANTS clearance.
 */
export async function enforceClearance(candidateId: string, actor: SessionUser | null, today: DateOnly): Promise<{ revoked: boolean; reasons: string[] }> {
  await connectDb();
  const quick = await Candidate.findById(candidateId).select("clearedToWork clearedEvidenceDocId").lean<{ clearedToWork: boolean; clearedEvidenceDocId?: string | null }>();
  if (!quick?.clearedToWork) return { revoked: false, reasons: [] };
  const ctx = await loadClearanceContext(candidateId, today);
  if (!ctx) return { revoked: false, reasons: [] };
  const decision = decideClearanceRevocation({
    currentlyCleared: true,
    evaluation: ctx.evaluation,
    clearedEvidenceDocId: quick.clearedEvidenceDocId,
    currentEvidenceDocId: ctx.period?.evidenceDocumentId,
  });
  if (decision.revoke) await revoke(actor, candidateId, decision.reasons, { automatic: true });
  return { revoked: decision.revoke, reasons: decision.reasons };
}
