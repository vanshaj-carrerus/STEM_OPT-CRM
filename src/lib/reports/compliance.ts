import { connectDb } from "@/lib/db/connect";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { Employer, type IEmployer } from "@/lib/db/models/employer";
import { User, type IUser } from "@/lib/db/models/user";
import { can, candidateScopeFilter, type Actor } from "@/lib/rbac/can";
import { addDays, diffDays, todayIn, type DateOnly } from "@/lib/compliance/dates";
import { AUTH_TYPE_LABELS, CANDIDATE_STAGES, STAGE_LABELS } from "@/lib/candidates/constants";
import { listTasks, monthlyReviewStats } from "@/lib/tasks/queries";
import { DEFAULT_TIMEZONE, isValidTimezone } from "@/lib/reminders/timezone";

/**
 * Compliance reports (long spec §15). Every report is scoped with the same record-level filter as the candidate list,
 * so counts reconcile with what the user can see and with the CSV export (AC-18).
 */
export type ReportActor = Actor & { timezone?: string };

export interface ReportTable {
  key: string;
  title: string;
  description?: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number>[];
  /** Hidden from the report list when the viewer lacks the data permission. */
  note?: string;
}

const todayOf = (a: ReportActor) => todayIn(isValidTimezone(a.timezone) ? a.timezone! : DEFAULT_TIMEZONE);
const ACTIVE_STAGES = ["new", "onboarding", "active", "on_hold"];

async function scoped(actor: ReportActor, extra: Record<string, unknown> = {}): Promise<ICandidate[]> {
  await connectDb();
  return Candidate.find({ ...candidateScopeFilter(actor), ...extra })
    .select("candidateCode legalName stage authType eadEnd eadStart ownerId currentEmployerId nextDueDate riskFlags i983Status")
    .lean<ICandidate[]>();
}

async function names(model: "user" | "employer", ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  if (model === "user") {
    const rows = await User.find({ _id: { $in: uniq } }).select("name").lean<IUser[]>();
    return new Map(rows.map((r) => [r._id, r.name]));
  }
  const rows = await Employer.find({ _id: { $in: uniq } }).select("legalName").lean<IEmployer[]>();
  return new Map(rows.map((r) => [r._id, r.legalName]));
}

/** Active candidates by CPT / OPT / STEM OPT and by employer/client. */
export async function activeByAuthorization(actor: ReportActor): Promise<ReportTable[]> {
  const list = await scoped(actor, { stage: { $in: ACTIVE_STAGES } });
  const byAuth = new Map<string, number>();
  const byEmployer = new Map<string, number>();
  for (const c of list) {
    byAuth.set(c.authType, (byAuth.get(c.authType) ?? 0) + 1);
    const e = c.currentEmployerId ?? "—";
    byEmployer.set(e, (byEmployer.get(e) ?? 0) + 1);
  }
  const emp = await names("employer", [...byEmployer.keys()]);
  return [
    {
      key: "active-by-auth",
      title: "Active candidates by authorization type",
      columns: [{ key: "type", label: "Authorization" }, { key: "count", label: "Candidates" }],
      rows: [...byAuth.entries()].sort().map(([t, n]) => ({ type: AUTH_TYPE_LABELS[t as keyof typeof AUTH_TYPE_LABELS] ?? t, count: n })),
    },
    {
      key: "active-by-employer",
      title: "Active candidates by employer / client",
      columns: [{ key: "employer", label: "Employer" }, { key: "count", label: "Candidates" }],
      rows: [...byEmployer.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => ({ employer: id === "—" ? "No employer on file" : (emp.get(id) ?? "Unknown employer"), count: n })),
    },
  ];
}

/** Authorizations expiring in 30/60/90 days, and expired ones that still need review. */
export async function expiringAuthorizations(actor: ReportActor): Promise<ReportTable> {
  const today = todayOf(actor);
  const list = (await scoped(actor, { stage: { $in: ACTIVE_STAGES }, authType: { $ne: "none" }, eadEnd: { $type: "string", $lte: addDays(today, 90) } }))
    .filter((c) => !!c.eadEnd)
    .sort((a, b) => a.eadEnd!.localeCompare(b.eadEnd!));
  const owners = await names("user", list.map((c) => c.ownerId));
  return {
    key: "expiring-authorizations",
    title: "Authorizations expiring within 90 days / expired",
    description: "Based on the candidate record's authorization end date. Expired authorizations require review with the DSO / counsel.",
    columns: [
      { key: "code", label: "Code" },
      { key: "name", label: "Candidate" },
      { key: "type", label: "Authorization" },
      { key: "ends", label: "Ends" },
      { key: "bucket", label: "Window" },
      { key: "owner", label: "Owner" },
    ],
    rows: list.map((c) => {
      const d = diffDays(c.eadEnd!, today);
      return {
        code: c.candidateCode,
        name: c.legalName,
        type: AUTH_TYPE_LABELS[c.authType],
        ends: c.eadEnd!,
        bucket: d < 0 ? `Expired ${Math.abs(d)}d ago — review` : d <= 30 ? "≤ 30 days" : d <= 60 ? "31–60 days" : "61–90 days",
        owner: c.ownerId ? (owners.get(c.ownerId) ?? "") : "Unassigned",
      };
    }),
  };
}

/** STEM validations due in 30 days and 12-/24-month evaluations due or overdue. */
export async function stemReporting(actor: ReportActor): Promise<ReportTable> {
  const today = todayOf(actor);
  const { rows } = await listTasks(actor, { kind: "milestone", status: "open", dueTo: addDays(today, 30) }, { pageSize: 500, today });
  const stem = rows.filter((r) => /stem|i-983|validation|evaluation/i.test(r.title));
  return {
    key: "stem-reporting",
    title: "STEM OPT validations & evaluations (due within 30 days or overdue)",
    description: "Internal reminders only — official reporting windows must be confirmed with each student's DSO.",
    columns: [
      { key: "candidate", label: "Candidate" },
      { key: "task", label: "Milestone" },
      { key: "due", label: "Internal due date" },
      { key: "status", label: "Status" },
      { key: "owner", label: "Owner" },
    ],
    rows: stem.map((r) => ({
      candidate: r.candidateName ?? "",
      task: r.title,
      due: r.dueDate,
      status: r.overdue ? `Overdue ${Math.abs(diffDays(r.dueDate, today))}d` : "Due soon",
      owner: r.ownerName ?? "Unassigned",
    })),
  };
}

/** Monthly reviews completed vs due, with overdue by owner. */
export async function monthlyReviews(actor: ReportActor): Promise<ReportTable> {
  const s = await monthlyReviewStats(actor, todayOf(actor));
  return {
    key: "monthly-reviews",
    title: "12-month reviews: completed vs due, overdue by owner",
    description: `Completed: ${s.completed} · Due (not yet overdue): ${s.due} · Overdue: ${s.overdue}`,
    columns: [{ key: "owner", label: "Owner" }, { key: "due", label: "Due" }, { key: "overdue", label: "Overdue" }, { key: "completed", label: "Completed" }],
    rows: s.byOwner.map((o) => ({ owner: o.ownerId ? (o.ownerName ?? "Unknown") : "Unassigned", due: o.due, overdue: o.overdue, completed: o.completed })),
  };
}

/** Candidate lifecycle funnel: New → Onboarding → Active → On Hold → Offboarded / Archived. */
export async function lifecycleFunnel(actor: ReportActor): Promise<ReportTable> {
  const list = await scoped(actor);
  const counts = new Map<string, number>(CANDIDATE_STAGES.map((s) => [s, 0]));
  for (const c of list) counts.set(c.stage, (counts.get(c.stage) ?? 0) + 1);
  return {
    key: "lifecycle",
    title: "Candidate lifecycle funnel",
    columns: [{ key: "stage", label: "Stage" }, { key: "count", label: "Candidates" }],
    rows: CANDIDATE_STAGES.map((s) => ({ stage: STAGE_LABELS[s], count: counts.get(s) ?? 0 })),
  };
}

/** Candidates with risk flags (overdue work, expiring authorization, CPT review, clearance revoked…). */
export async function atRisk(actor: ReportActor): Promise<ReportTable> {
  const list = (await scoped(actor, { "riskFlags.0": { $exists: true }, stage: { $in: ACTIVE_STAGES } })).sort((a, b) => b.riskFlags.length - a.riskFlags.length);
  const owners = await names("user", list.map((c) => c.ownerId));
  return {
    key: "at-risk",
    title: "Candidates with open risk flags",
    columns: [{ key: "code", label: "Code" }, { key: "name", label: "Candidate" }, { key: "flags", label: "Flags" }, { key: "owner", label: "Owner" }, { key: "next", label: "Next due" }],
    rows: list.map((c) => ({
      code: c.candidateCode,
      name: c.legalName,
      flags: c.riskFlags.join("; "),
      owner: c.ownerId ? (owners.get(c.ownerId) ?? "") : "Unassigned",
      next: c.nextDueDate ?? "",
    })),
  };
}

export const COMPLIANCE_REPORTS = [
  { key: "lifecycle", label: "Lifecycle funnel" },
  { key: "active", label: "Active by authorization / employer" },
  { key: "expiring", label: "Authorizations expiring", needs: "immigration.view" as const },
  { key: "stem", label: "STEM validations & evaluations", needs: "immigration.view" as const },
  { key: "monthly", label: "12-month reviews", needs: "tracker.view" as const },
  { key: "risk", label: "At-risk candidates", needs: "immigration.view" as const },
] as const;

export type ComplianceReportKey = (typeof COMPLIANCE_REPORTS)[number]["key"];

export function availableComplianceReports(actor: ReportActor) {
  return COMPLIANCE_REPORTS.filter((r) => !("needs" in r) || can(actor, r.needs));
}

export async function buildComplianceReport(actor: ReportActor, key: string): Promise<ReportTable[] | null> {
  const allowed = availableComplianceReports(actor).some((r) => r.key === key);
  if (!allowed) return null;
  switch (key as ComplianceReportKey) {
    case "lifecycle": return [await lifecycleFunnel(actor)];
    case "active": return activeByAuthorization(actor);
    case "expiring": return [await expiringAuthorizations(actor)];
    case "stem": return [await stemReporting(actor)];
    case "monthly": return [await monthlyReviews(actor)];
    case "risk": return [await atRisk(actor)];
  }
}

export type { DateOnly };
