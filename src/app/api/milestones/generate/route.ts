import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, route } from "@/lib/api";
import { loadCandidateFor, requireAction } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { regenerateSchedule } from "@/lib/immigration/schedule";

export const dynamic = "force-dynamic";

const body = z.object({ candidateId: z.string().trim().min(1).max(64) });

/**
 * POST /api/milestones/generate  { candidateId } — re-derive milestones from VERIFIED authorization periods.
 * Requires `immigration.edit`. Idempotent; returns counts only.
 */
export const POST = route(async (user, req: NextRequest) => {
  await requireAction("immigration.edit");
  const { candidateId } = body.parse(await req.json());
  const candidate = await loadCandidateFor(user, candidateId);
  if (!candidate) return apiError(404, "Candidate not found");
  const result = await regenerateSchedule({ actor: user, candidateId });
  await audit({
    actor: user, action: "system", entityType: "milestones", candidateId, source: "api",
    summary: `Regenerated compliance schedule (created ${result.created}, updated ${result.updated}, reopened ${result.reopened}, cancelled ${result.cancelled})`,
  });
  return NextResponse.json(result);
});
