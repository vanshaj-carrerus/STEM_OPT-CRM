import { connectDb } from "@/lib/db/connect";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import {
  AuthorizationPeriod,
  Employer,
  EmploymentRecord,
  type IAuthorizationPeriod,
  type IEmployer,
  type IEmploymentRecord,
} from "@/lib/db/models/employer";
import { I983Record, type II983Record } from "@/lib/db/models/immigration-extra";
import { evaluateClearance, type ClearanceResult } from "@/lib/compliance/clearance";
import type { DateOnly } from "@/lib/compliance/dates";
import { extraClearanceBlockers, pickGoverningPeriod } from "./clearance-rules";
import { getEvidenceDoc, isDocVerified, type EvidenceDocInfo } from "./evidence";

/**
 * Everything the clearance guard needs, read from IMMIGRATION data only (periods, evidence, I-983, employment).
 * Payroll / payment collections are deliberately never imported here.
 */
export interface ClearanceContext {
  candidate: ICandidate;
  periods: IAuthorizationPeriod[];
  period: IAuthorizationPeriod | null;
  workRecord: IEmploymentRecord | null;
  evidence: EvidenceDocInfo | null;
  i983: II983Record | null;
  evaluation: ClearanceResult;
}

export const I983_OK_STATUSES = ["signed", "submitted_to_dso"];

/** The employment record the clearance is about: the active record for the current employer, else the latest active one. */
export function pickWorkRecord(records: IEmploymentRecord[], currentEmployerId?: string | null): IEmploymentRecord | null {
  const active = records.filter((r) => r.status === "active");
  if (!active.length) return null;
  const preferred = currentEmployerId ? active.filter((r) => r.employerId === currentEmployerId) : [];
  const pool = preferred.length ? preferred : active;
  return [...pool].sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""))[0];
}

export async function loadClearanceContext(candidateId: string, today: DateOnly): Promise<ClearanceContext | null> {
  await connectDb();
  const candidate = await Candidate.findById(candidateId).lean<ICandidate>();
  if (!candidate) return null;
  const [periods, records] = await Promise.all([
    AuthorizationPeriod.find({ candidateId }).lean<IAuthorizationPeriod[]>(),
    EmploymentRecord.find({ candidateId }).lean<IEmploymentRecord[]>(),
  ]);
  const workRecord = pickWorkRecord(records, candidate.currentEmployerId);
  const period = pickGoverningPeriod(periods, {
    authType: candidate.authType,
    workEmployerId: workRecord?.employerId ?? candidate.currentEmployerId,
    plannedWorkStart: workRecord?.startDate,
    today,
  });

  if (!period) {
    return {
      candidate, periods, period: null, workRecord, evidence: null, i983: null,
      evaluation: { cleared: false, reasons: ["No authorization period (CPT / OPT / STEM OPT) is recorded for this candidate."], warnings: [] },
    };
  }

  const [evidence, i983, employer] = await Promise.all([
    getEvidenceDoc(candidateId, period.evidenceDocumentId),
    period.type === "STEM_OPT" ? I983Record.findOne({ authorizationPeriodId: period._id }).lean<II983Record>() : Promise.resolve(null),
    period.type === "STEM_OPT" && (period.employerId ?? workRecord?.employerId)
      ? Employer.findById(period.employerId ?? workRecord!.employerId).select("everifyCompanyId").lean<IEmployer>()
      : Promise.resolve(null),
  ]);

  const base = evaluateClearance({
    type: period.type,
    authStart: period.startDate,
    authEnd: period.endDate,
    plannedWorkStart: workRecord?.startDate,
    authEmployerId: period.employerId,
    workEmployerId: workRecord?.employerId ?? candidate.currentEmployerId,
    evidenceDocumentId: period.evidenceDocumentId,
    // evidence counts only when BOTH the period was verified by a reviewer AND the document itself is verified right now
    evidenceVerified: period.verification === "verified" && isDocVerified(evidence),
    verifiedById: period.verification === "verified" ? period.verifiedBy : null,
    i983Verified: !!i983 && i983.verification === "verified" && I983_OK_STATUSES.includes(i983.status),
    everifyCompanyIdPresent: !!employer?.everifyCompanyId?.enc,
    hoursPerWeek: workRecord?.hoursPerWeek ?? null,
    today,
  });
  const extra = extraClearanceBlockers({
    type: period.type,
    evidenceDocType: evidence?.type,
    i20EndorsementDate: candidate.i20EndorsementDate,
    plannedWorkStart: workRecord?.startDate,
  });
  return {
    candidate, periods, period, workRecord, evidence, i983,
    evaluation: { cleared: base.cleared && extra.length === 0, reasons: [...base.reasons, ...extra], warnings: base.warnings },
  };
}
