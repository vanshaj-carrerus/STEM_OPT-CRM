import { ROLE_PERMISSIONS, type Permission, type Role } from "./permissions";

/** Minimal shape of the authenticated user that RBAC needs (kept free of DB types so it is easy to test). */
export interface Actor {
  id: string;
  role: Role;
  /** Extra permissions granted explicitly by a Super Admin (e.g. sensitive.* reveal). Always logged on use. */
  extraPermissions?: Permission[];
  /** Permissions explicitly revoked from the role default. */
  deniedPermissions?: Permission[];
  teamIds?: string[];
}

export function permissionsFor(actor: Actor): Set<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[actor.role] ?? []);
  for (const p of actor.extraPermissions ?? []) set.add(p);
  for (const p of actor.deniedPermissions ?? []) set.delete(p);
  return set;
}

export function can(actor: Actor | null | undefined, permission: Permission): boolean {
  if (!actor) return false;
  return permissionsFor(actor).has(permission);
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = "You do not have permission to perform this action.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** No valid session (missing, expired, idle-timed-out, or still waiting for the OTP) → HTTP 401, not 403. */
export class UnauthenticatedError extends ForbiddenError {
  status = 401;
  constructor(message = "Your session has expired. Please sign in again.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export function assertCan(actor: Actor | null | undefined, permission: Permission): asserts actor is Actor {
  if (!can(actor, permission)) throw new ForbiddenError();
}

/** Record-level rule for candidates: assigned-only roles see just their own / team candidates. */
export interface CandidateScope {
  ownerId?: string | null;
  teamMemberIds?: string[];
}

export function canAccessCandidate(actor: Actor | null | undefined, c: CandidateScope): boolean {
  if (!actor || !can(actor, "candidates.view")) return false;
  if (can(actor, "candidates.viewAll")) return true;
  return c.ownerId === actor.id || (c.teamMemberIds ?? []).includes(actor.id);
}

/** Mongo filter that applies the same record-level scope to list queries. */
export function candidateScopeFilter(actor: Actor): Record<string, unknown> {
  if (can(actor, "candidates.viewAll")) return {};
  return { $or: [{ ownerId: actor.id }, { teamMemberIds: actor.id }] };
}
