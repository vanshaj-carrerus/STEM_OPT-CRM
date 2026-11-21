import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ForbiddenError } from "@/lib/rbac/can";
import { SeparationOfDutiesError } from "@/lib/sod";
import { CandidateValidationError, DuplicateCandidateError } from "@/lib/candidates/service";
import { rateLimit } from "@/lib/auth/ratelimit";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { requestHeaders as headers } from "@/lib/request-context";

/** Standard JSON error envelope: { error, code?, details? } — never leaks stack traces or secrets. */
export function apiError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

/** Wrap a route handler: auth, per-user rate limit, consistent error mapping, correlation id. */
export function route<A extends unknown[]>(
  handler: (user: SessionUser, ...args: A) => Promise<Response>,
  opts: { limitPerMin?: number } = {},
) {
  return async (...args: A): Promise<Response> => {
    const correlationId = (await headers()).get("x-correlation-id") ?? crypto.randomUUID();
    try {
      const user = await getSessionUser();
      if (!user) return apiError(401, "Unauthenticated");
      const rl = await rateLimit(`api:${user.id}`, opts.limitPerMin ?? 240, 60);
      if (!rl.allowed) return apiError(429, "Rate limit exceeded", { retryAfterSec: rl.retryAfterSec });
      const res = await handler(user, ...args);
      res.headers.set("x-correlation-id", correlationId);
      return res;
    } catch (e) {
      if (e instanceof ForbiddenError) return apiError(e.status, e.message); // 401 when the session is gone, else 403
      if (e instanceof SeparationOfDutiesError) return apiError(403, e.message, { code: "separation_of_duties" });
      if ((e as Error)?.name === "SyntaxError") return apiError(400, "The request body is not valid JSON."); // req.json() on a malformed body
      if (e instanceof CandidateValidationError) return apiError(422, e.message);
      if (e instanceof DuplicateCandidateError) return apiError(409, e.message, { code: "duplicate", matches: e.matches });
      if (e instanceof ZodError) {
        return apiError(422, "Validation failed", { details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      }
      console.error(`[api ${correlationId}]`, e);
      return apiError(500, "Internal error", { correlationId });
    }
  };
}

export function pageParams(sp: URLSearchParams, defSize = 25) {
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize")) || defSize));
  return { page, pageSize };
}
