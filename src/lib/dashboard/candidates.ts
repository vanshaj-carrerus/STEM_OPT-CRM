import { connectDb } from "@/lib/db/connect";
import { Candidate } from "@/lib/db/models/candidate";
import { can, candidateScopeFilter, type Actor } from "@/lib/rbac/can";
import { addDays, type DateOnly } from "@/lib/compliance/dates";

/**
 * Candidate KPI counts for the dashboard. Every count uses the same record-level scope as the candidate list
 * (`candidateScopeFilter`) and the same filter builder, so each tile equals the count of its linked, filtered list (AC-18).
 */
export interface DashboardFilters {
  ownerId?: string; // user id or "unassigned"
  authType?: string; // CPT | OPT | STEM_OPT
}

const ACTIVE = ["new", "onboarding", "active", "on_hold"];

export interface CandidateKpis {
  total: number;
  active: number;
  byAuth: { CPT: number; OPT: number; STEM_OPT: number };
  expired: number;
  expiring30: number;
  expiring60: number;
  expiring90: number;
  withRiskFlags: number;
}

function base(actor: Actor, f: DashboardFilters): Record<string, unknown>[] {
  const and: Record<string, unknown>[] = [candidateScopeFilter(actor)];
  if (f.ownerId) and.push({ ownerId: f.ownerId === "unassigned" ? null : f.ownerId });
  if (f.authType && can(actor, "immigration.view")) and.push({ authType: f.authType });
  return and;
}

export async function candidateKpis(actor: Actor, today: DateOnly, f: DashboardFilters = {}): Promise<CandidateKpis> {
  await connectDb();
  const count = (...extra: Record<string, unknown>[]) => Candidate.countDocuments({ $and: [...base(actor, f), ...extra] });
  const showImm = can(actor, "immigration.view");
  const auth = (type: string) => count({ stage: { $in: ACTIVE }, authType: type });
  const expiring = (days: number) =>
    count({ stage: { $in: ACTIVE }, authType: { $ne: "none" }, eadEnd: { $type: "string", $gte: today, $lte: addDays(today, days) } });

  const [total, active, cpt, opt, stem, expired, e30, e60, e90, risk] = await Promise.all([
    count(),
    count({ stage: { $in: ACTIVE } }),
    showImm ? auth("CPT") : 0,
    showImm ? auth("OPT") : 0,
    showImm ? auth("STEM_OPT") : 0,
    showImm ? count({ stage: { $in: ACTIVE }, authType: { $ne: "none" }, eadEnd: { $type: "string", $lt: today } }) : 0,
    showImm ? expiring(30) : 0,
    showImm ? expiring(60) : 0,
    showImm ? expiring(90) : 0,
    showImm ? count({ stage: { $in: ACTIVE }, "riskFlags.0": { $exists: true } }) : 0,
  ]);
  return { total, active, byAuth: { CPT: cpt, OPT: opt, STEM_OPT: stem }, expired, expiring30: e30, expiring60: e60, expiring90: e90, withRiskFlags: risk };
}
