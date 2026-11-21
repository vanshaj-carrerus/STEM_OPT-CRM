import { loadCandidateFor } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/rbac/can";
import type { ICandidate } from "@/lib/db/models/candidate";

/** Record-level guard for services: a candidate the actor can't access is reported as "not found". */
export async function requireCandidate(actor: SessionUser, candidateId: string): Promise<ICandidate> {
  const c = await loadCandidateFor(actor, candidateId);
  if (!c) throw new ForbiddenError("Candidate not found.");
  return c;
}

/** Thrown for invalid business operations (shown to the user as a message, not a 500). */
export class ImmigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImmigrationError";
  }
}
