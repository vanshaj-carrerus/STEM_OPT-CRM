import { apiError, route } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/session";
import { PayrollError } from "./errors";

/** `route()` plus mapping of payroll business-rule errors to 404/409/422 JSON responses. */
export function payrollRoute<A extends unknown[]>(handler: (user: SessionUser, ...args: A) => Promise<Response>, opts: { limitPerMin?: number } = {}) {
  return route<A>(async (user, ...args) => {
    try {
      return await handler(user, ...args);
    } catch (e) {
      if (e instanceof PayrollError) return apiError(e.status, e.message, { code: e.code });
      throw e;
    }
  }, opts);
}
