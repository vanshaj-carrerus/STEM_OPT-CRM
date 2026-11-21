import { NextResponse, type NextRequest } from "next/server";
import { apiError, route } from "@/lib/api";
import { loadCandidateFor } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { can } from "@/lib/rbac/can";
import { connectDb } from "@/lib/db/connect";
import { AuditEvent, type IAuditEvent } from "@/lib/db/models/audit";
import { loadImmigrationOverview } from "@/lib/immigration/overview";
import { todayFor } from "@/lib/immigration/calendar";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/candidates/{id}/timeline — authorization periods, milestones and activity, trimmed to the caller's permissions:
 *  - periods / milestones / CPT review / unemployment need `immigration.view` (evidence ids also need `documents.view`)
 *  - activity needs `audit.view`
 */
export const GET = route(async (user, _req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const candidate = await loadCandidateFor(user, id);
  if (!candidate) return apiError(404, "Candidate not found");
  const canImmigration = can(user, "immigration.view");
  const canAudit = can(user, "audit.view");
  if (!canImmigration && !canAudit) return apiError(403, "You do not have permission to perform this action.");

  const body: Record<string, unknown> = { candidateId: id };
  if (canImmigration) {
    const o = await loadImmigrationOverview(user, candidate, todayFor(user));
    const seeDocs = can(user, "documents.view");
    body.authorizationPeriods = o.periods.map((p) => ({
      ...p,
      evidenceDocumentId: seeDocs ? p.evidenceDocumentId : undefined,
      evidence: seeDocs ? p.evidence : undefined,
      i983: p.i983 ? { ...p.i983, evidenceDocumentId: seeDocs ? p.i983.evidenceDocumentId : undefined } : p.i983,
    }));
    body.milestones = o.milestones;
    body.clearance = { cleared: o.clearance.cleared, reasons: o.clearance.reasons, warnings: o.clearance.warnings };
    body.cptFullTimeReview = o.cpt;
    body.unemployment = { totalDays: o.unemployment.status.totalDays, level: o.unemployment.status.level, note: o.unemployment.status.label };
  }
  if (canAudit) {
    await connectDb();
    const rows = await AuditEvent.find({ candidateId: id }).sort({ createdAt: -1 }).limit(100).lean<IAuditEvent[]>();
    body.activity = rows.map((r) => ({ at: r.createdAt, by: r.actorEmail ?? "system", action: r.action, entityType: r.entityType, summary: r.summary }));
  }
  await audit({ actor: user, action: "read", entityType: "candidate_timeline", entityId: id, candidateId: id, source: "api", summary: "Viewed immigration timeline via API" });
  return NextResponse.json(body);
});
