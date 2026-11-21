import { ZodError } from "zod";
import { ForbiddenError } from "@/lib/rbac/can";
import { SeparationOfDutiesError } from "@/lib/sod";

/** Business-rule failure with an HTTP-ish status (409 conflict, 422 validation, 404 not found). */
export class PayrollError extends Error {
  constructor(
    message: string,
    public status: 404 | 409 | 422 = 409,
    public code?: string,
  ) {
    super(message);
    this.name = "PayrollError";
  }
}

export interface ActionResult {
  ok?: boolean;
  error?: string;
  message?: string;
}

/** Turn any thrown business/permission error into a user-facing form state (server actions never leak stacks). */
export function toActionError(e: unknown): ActionResult {
  if (e instanceof PayrollError || e instanceof ForbiddenError || e instanceof SeparationOfDutiesError) return { error: e.message };
  if (e instanceof ZodError) return { error: e.issues.map((i) => i.message).join(" ") || "Please check the form." };
  throw e;
}
