import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "./session";
import { can, ForbiddenError, UnauthenticatedError, canAccessCandidate } from "@/lib/rbac/can";
import type { Permission } from "@/lib/rbac/permissions";
import { connectDb } from "@/lib/db/connect";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";

/** For pages/layouts: redirect to login if unauthenticated, to dashboard if lacking permission. */
export async function requirePage(...anyOf: Permission[]): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) redirect("/login");
  if (u.mustChangePassword) redirect("/change-password");
  if (anyOf.length && !anyOf.some((p) => can(u, p))) redirect("/dashboard");
  return u;
}

/** For server actions / route handlers: throws instead of redirecting. */
export async function requireAction(...anyOf: Permission[]): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) throw new UnauthenticatedError();
  if (u.mustChangePassword) throw new ForbiddenError("Change your password before continuing.");
  if (anyOf.length && !anyOf.some((p) => can(u, p))) throw new ForbiddenError();
  return u;
}

/**
 * Load a candidate ONLY if the actor may see it (permission + record-level assignment).
 * Returns null when it doesn't exist or the actor lacks access — callers should treat both as "not found"
 * so record existence isn't leaked.
 */
export async function loadCandidateFor(actor: SessionUser, candidateId: string): Promise<ICandidate | null> {
  await connectDb();
  const c = await Candidate.findById(candidateId).lean<ICandidate>();
  if (!c) return null;
  return canAccessCandidate(actor, { ownerId: c.ownerId, teamMemberIds: c.teamMemberIds }) ? c : null;
}
