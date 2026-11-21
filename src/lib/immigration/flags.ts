import { connectDb } from "@/lib/db/connect";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { AuthorizationPeriod, EmploymentRecord, type IAuthorizationPeriod } from "@/lib/db/models/employer";
import { UnemploymentPeriod, type IUnemploymentPeriod } from "@/lib/db/models/immigration-extra";
import { compareDates, type DateOnly } from "@/lib/compliance/dates";
import { cptReview, DERIVED_RISK_FLAGS, deriveRiskFlags } from "./flags-rules";
import { totalUnemploymentDays, unemploymentStatus } from "./unemployment";
import { getEvidenceDocs, isDocVerified, type EvidenceDocInfo } from "./evidence";

/** A period counts as verified only while BOTH the reviewer's verification and the evidence document's own verification hold. */
export function isEffectivelyVerified(p: Pick<IAuthorizationPeriod, "verification" | "evidenceDocumentId">, docs: Map<string, EvidenceDocInfo>): boolean {
  return p.verification === "verified" && !!p.evidenceDocumentId && isDocVerified(docs.get(p.evidenceDocumentId));
}

/** Recompute the immigration-owned risk flags on the candidate (other modules' flags are preserved). */
export async function refreshRiskFlags(candidateId: string, today: DateOnly): Promise<string[]> {
  await connectDb();
  const candidate = await Candidate.findById(candidateId).select("authType degreeLevel").lean<ICandidate>();
  if (!candidate) return [];
  const [periods, activeCount, unemployment] = await Promise.all([
    AuthorizationPeriod.find({ candidateId }).lean<IAuthorizationPeriod[]>(),
    EmploymentRecord.countDocuments({ candidateId, status: "active" }),
    UnemploymentPeriod.find({ candidateId }).lean<IUnemploymentPeriod[]>(),
  ]);
  const docs = await getEvidenceDocs(candidateId, periods.map((p) => p.evidenceDocumentId));
  const coversToday = periods.some(
    (p) => isEffectivelyVerified(p, docs) && compareDates(p.startDate, today) <= 0 && compareDates(p.endDate, today) >= 0,
  );
  const unemp = unemploymentStatus(totalUnemploymentDays(unemployment, today), candidate.authType);
  const flags = deriveRiskFlags({
    cptFlag: cptReview(periods, candidate.degreeLevel).flag,
    hasActiveEmployment: activeCount > 0,
    hasVerifiedCoverageToday: coversToday,
    unemploymentLevel: unemp.level,
  });
  await Candidate.updateOne({ _id: candidateId }, { $pull: { riskFlags: { $in: DERIVED_RISK_FLAGS } } });
  if (flags.length) await Candidate.updateOne({ _id: candidateId }, { $addToSet: { riskFlags: { $each: flags } } });
  return flags;
}
