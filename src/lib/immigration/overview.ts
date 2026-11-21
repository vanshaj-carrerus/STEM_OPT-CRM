import { connectDb } from "@/lib/db/connect";
import { AuthorizationPeriod, Employer, type IAuthorizationPeriod, type IEmployer } from "@/lib/db/models/employer";
import { I983Record, UnemploymentPeriod, type II983Record, type IUnemploymentPeriod } from "@/lib/db/models/immigration-extra";
import { Task, type ITask } from "@/lib/db/models/task";
import type { ICandidate } from "@/lib/db/models/candidate";
import { userNameMap } from "@/lib/users/directory";
import { can, type Actor } from "@/lib/rbac/can";
import type { DateOnly } from "@/lib/compliance/dates";
import { loadClearanceContext } from "./context";
import { getEvidenceDocs, listEvidenceCandidates, type EvidenceDocInfo } from "./evidence";
import { isEffectivelyVerified } from "./flags";
import { cptReview } from "./flags-rules";
import { totalUnemploymentDays, unemploymentStatus, type UnemploymentStatus } from "./unemployment";

/** Plain-JSON view models for the Immigration tab and the timeline API. Ciphertext and raw user docs never appear here. */
export interface I983View {
  id: string;
  status: II983Record["status"];
  formVersion?: string;
  studentSignedOn?: string;
  employerSignedOn?: string;
  dsoSubmittedOn?: string;
  trainingPlanSummary?: string;
  evidenceDocumentId?: string | null;
  verification: II983Record["verification"];
  verifiedByName?: string;
}

export interface PeriodView {
  id: string;
  type: IAuthorizationPeriod["type"];
  category?: string;
  startDate: DateOnly;
  endDate: DateOnly;
  employerId?: string | null;
  employerName?: string;
  fullTime?: boolean;
  educationLevel?: string;
  evidenceDocumentId?: string | null;
  evidence?: Pick<EvidenceDocInfo, "type" | "title" | "fileName" | "verification" | "version"> | null;
  verification: IAuthorizationPeriod["verification"];
  /** Reviewer verification AND the evidence document currently verified. Only these periods generate milestones. */
  effectivelyVerified: boolean;
  verifiedByName?: string;
  verifiedAt?: string;
  notes?: string;
  i983?: I983View | null;
}

export interface MilestoneView {
  id: string;
  kind: ITask["kind"];
  title: string;
  dueDate: DateOnly;
  status: ITask["status"];
  milestoneType?: string;
  authorizationPeriodId?: string;
}

export interface UnemploymentView {
  id: string;
  startDate: DateOnly;
  endDate?: DateOnly | null;
  notes?: string;
  verifiedByName?: string;
  verified: boolean;
}

export interface ImmigrationOverview {
  periods: PeriodView[];
  milestones: MilestoneView[];
  clearance: {
    cleared: boolean;
    clearedByName?: string;
    clearedAt?: string;
    reasons: string[];
    warnings: string[];
    governingPeriodId?: string;
    plannedWorkStart?: string;
  };
  cpt: { flag: boolean; days: number; message?: string };
  unemployment: { rows: UnemploymentView[]; status: UnemploymentStatus };
  evidenceOptions: EvidenceDocInfo[];
  employers: { id: string; name: string }[];
}

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : undefined);

export async function loadImmigrationOverview(actor: Actor, candidate: ICandidate, today: DateOnly): Promise<ImmigrationOverview> {
  await connectDb();
  const candidateId = candidate._id;
  const [periods, i983s, unemployment, tasks, employers, evidenceOptions, ctx] = await Promise.all([
    AuthorizationPeriod.find({ candidateId }).sort({ startDate: 1 }).lean<IAuthorizationPeriod[]>(),
    I983Record.find({ candidateId }).lean<II983Record[]>(),
    UnemploymentPeriod.find({ candidateId }).sort({ startDate: 1 }).lean<IUnemploymentPeriod[]>(),
    Task.find({ candidateId, kind: { $in: ["milestone", "change_review"] }, category: "immigration" }).sort({ dueDate: 1 }).limit(100).lean<ITask[]>(),
    Employer.find({}).select("legalName").sort({ legalNameLower: 1 }).limit(500).lean<IEmployer[]>(),
    can(actor, "documents.view") && can(actor, "immigration.edit") ? listEvidenceCandidates(actor, candidateId) : Promise.resolve([]),
    loadClearanceContext(candidateId, today),
  ]);
  const docs = await getEvidenceDocs(candidateId, [...periods.map((p) => p.evidenceDocumentId), ...i983s.map((r) => r.evidenceDocumentId)]);
  const names = await userNameMap([
    ...periods.map((p) => p.verifiedBy),
    ...i983s.map((r) => r.verifiedBy),
    ...unemployment.map((u) => u.verifiedBy),
    candidate.clearedBy,
  ]);
  const employerName = new Map(employers.map((e) => [e._id, e.legalName]));
  const i983ByPeriod = new Map(i983s.map((r) => [r.authorizationPeriodId, r]));

  const periodViews: PeriodView[] = periods.map((p) => {
    const doc = p.evidenceDocumentId ? docs.get(p.evidenceDocumentId) : undefined;
    const r = i983ByPeriod.get(p._id);
    return {
      id: p._id,
      type: p.type,
      category: p.category,
      startDate: p.startDate,
      endDate: p.endDate,
      employerId: p.employerId,
      employerName: p.employerId ? employerName.get(p.employerId) : undefined,
      fullTime: p.fullTime,
      educationLevel: p.educationLevel,
      evidenceDocumentId: p.evidenceDocumentId,
      evidence: doc ? { type: doc.type, title: doc.title, fileName: doc.fileName, verification: doc.verification, version: doc.version } : null,
      verification: p.verification,
      effectivelyVerified: isEffectivelyVerified(p, docs),
      verifiedByName: p.verifiedBy ? names[p.verifiedBy] : undefined,
      verifiedAt: iso(p.verifiedAt),
      notes: p.notes,
      i983: r
        ? {
            id: r._id, status: r.status, formVersion: r.formVersion, studentSignedOn: r.studentSignedOn, employerSignedOn: r.employerSignedOn,
            dsoSubmittedOn: r.dsoSubmittedOn, trainingPlanSummary: r.trainingPlanSummary, evidenceDocumentId: r.evidenceDocumentId,
            verification: r.verification, verifiedByName: r.verifiedBy ? names[r.verifiedBy] : undefined,
          }
        : null,
    };
  });

  const evaluation = ctx?.evaluation ?? { cleared: false, reasons: ["Candidate not found."], warnings: [] };
  return {
    periods: periodViews,
    milestones: tasks.map((t) => ({
      id: t._id,
      kind: t.kind,
      title: t.title,
      dueDate: t.dueDate,
      status: t.status,
      milestoneType: t.meta?.milestoneType as string | undefined,
      authorizationPeriodId: t.meta?.authorizationPeriodId as string | undefined,
    })),
    clearance: {
      cleared: candidate.clearedToWork,
      clearedByName: candidate.clearedBy ? names[candidate.clearedBy] : undefined,
      clearedAt: iso(candidate.clearedAt),
      reasons: evaluation.reasons,
      warnings: evaluation.warnings,
      governingPeriodId: ctx?.period?._id,
      plannedWorkStart: ctx?.workRecord?.startDate,
    },
    cpt: cptReview(periods, candidate.degreeLevel),
    unemployment: {
      rows: unemployment.map((u) => ({
        id: u._id, startDate: u.startDate, endDate: u.endDate, notes: u.notes,
        verified: !!u.verifiedBy, verifiedByName: u.verifiedBy ? names[u.verifiedBy] : undefined,
      })),
      status: unemploymentStatus(totalUnemploymentDays(unemployment, today), candidate.authType),
    },
    evidenceOptions,
    employers: employers.map((e) => ({ id: e._id, name: e.legalName })),
  };
}
