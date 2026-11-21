import { apiError, route } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/session";
import { MoneyError } from "./money";
import { PaymentError } from "./errors";

/** `route()` plus mapping of payment-domain errors to clean JSON responses (never a 500 for expected failures). */
export function paymentRoute<A extends unknown[]>(handler: (user: SessionUser, ...args: A) => Promise<Response>, opts: { limitPerMin?: number } = {}) {
  return route<A>(async (user, ...args) => {
    try {
      return await handler(user, ...args);
    } catch (e) {
      if (e instanceof PaymentError) return apiError(e.status, e.message, { code: e.code, ...(e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}) });
      if (e instanceof MoneyError) return apiError(422, e.message, { code: "validation" });
      throw e;
    }
  }, opts);
}
