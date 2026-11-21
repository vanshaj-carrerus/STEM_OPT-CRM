import { ZodError } from "zod";
import { ForbiddenError } from "@/lib/rbac/can";
import { ImmigrationError } from "@/lib/immigration/access";
import { ClearanceBlockedError } from "@/lib/immigration/clearance-service";
import { EmployerError } from "@/lib/employers/service";

/** Shared result shape for compliance-module server actions (form actions and button actions). */
export interface ActionState {
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Blocking reasons (e.g. why clearance was refused). */
  reasons?: string[];
  saved?: boolean;
  message?: string;
}

export function formToObject(fd: FormData): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") o[k] = v;
  return o;
}

export function zodFieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of err.issues) out[String(i.path[0] ?? "form")] ??= i.message;
  return out;
}

/** Convert expected failures into user-facing state; unexpected errors still throw (and are logged by Next). */
export async function run(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    const r = await fn();
    return r ?? { saved: true };
  } catch (e) {
    if (e instanceof ZodError) return { error: "Please fix the highlighted fields.", fieldErrors: zodFieldErrors(e) };
    if (e instanceof ClearanceBlockedError) return { error: "Cannot clear to work yet.", reasons: e.reasons };
    if (e instanceof ForbiddenError || e instanceof ImmigrationError || e instanceof EmployerError) return { error: e.message };
    throw e;
  }
}
