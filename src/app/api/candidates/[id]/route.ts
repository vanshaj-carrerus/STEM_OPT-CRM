import { NextResponse, type NextRequest } from "next/server";
import { apiError, route } from "@/lib/api";
import { loadCandidateFor } from "@/lib/auth/guard";
import { candidatePatchSchema } from "@/lib/candidates/schema";
import { toCandidateView, updateCandidate } from "@/lib/candidates/service";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/candidates/{id} — profile trimmed to what the caller may see (protected IDs are masks only). */
export const GET = route(async (user, _req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const c = await loadCandidateFor(user, id);
  if (!c) return apiError(404, "Candidate not found");
  await audit({ actor: user, action: "read", entityType: "candidate", entityId: id, candidateId: id, source: "api", summary: "Viewed candidate via API" });
  return NextResponse.json(toCandidateView(user, c));
});

/** PATCH /api/candidates/{id} — partial update with field-level permission checks. */
export const PATCH = route(async (user, req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = candidatePatchSchema.parse(await req.json());
  const updated = await updateCandidate(user, id, body);
  return NextResponse.json(toCandidateView(user, updated));
});
