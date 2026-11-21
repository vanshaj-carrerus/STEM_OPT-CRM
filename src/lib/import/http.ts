import { apiError } from "@/lib/api";
import { ImportError } from "./service";
import { ImportParseError } from "./parse";

/** Maps import-specific failures to JSON errors; returns null for anything else so `route()` handles it. */
export function importErrorResponse(e: unknown): Response | null {
  if (e instanceof ImportError) return apiError(e.status, e.message);
  if (e instanceof ImportParseError) return apiError(422, e.message);
  return null;
}
