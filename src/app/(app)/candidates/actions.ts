"use server";

import { redirect } from "next/navigation";
import { revalidate as revalidatePath } from "@/lib/request-context";
import { z } from "zod";
import { requireAction } from "@/lib/auth/guard";
import { candidateCreateSchema, candidatePatchSchema } from "@/lib/candidates/schema";
import {
  CandidateValidationError,
  DuplicateCandidateError,
  addContactEntry,
  addNote,
  bulkUpdate,
  createCandidate,
  revealSensitive,
  updateCandidate,
} from "@/lib/candidates/service";
import { ForbiddenError } from "@/lib/rbac/can";

export interface CandidateFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
  duplicates?: { id: string; code: string; name: string; email: string; reason: string }[];
  softDuplicate?: boolean;
  saved?: boolean;
}

function formToObject(fd: FormData) {
  const o: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v === "string") o[k] = v;
  }
  return o;
}

function fieldErrors(err: z.ZodError) {
  const out: Record<string, string> = {};
  for (const i of err.issues) out[String(i.path[0] ?? "form")] ??= i.message;
  return out;
}

function handle(err: unknown): CandidateFormState {
  if (err instanceof DuplicateCandidateError) {
    return { error: err.message, duplicates: err.matches, softDuplicate: err.kind === "soft" };
  }
  if (err instanceof CandidateValidationError || err instanceof ForbiddenError) return { error: err.message };
  throw err;
}

export async function createCandidateAction(_p: CandidateFormState, fd: FormData): Promise<CandidateFormState> {
  const actor = await requireAction("candidates.create");
  const parsed = candidateCreateSchema.safeParse(formToObject(fd));
  if (!parsed.success) return { error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  let id: string;
  try {
    const c = await createCandidate(actor, parsed.data, { allowSoftDuplicate: fd.get("allowSoftDuplicate") === "on" });
    id = c._id;
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/candidates");
  redirect(`/candidates/${id}`);
}

export async function updateCandidateAction(_p: CandidateFormState, fd: FormData): Promise<CandidateFormState> {
  const actor = await requireAction("candidates.edit");
  const id = String(fd.get("id") ?? "");
  const parsed = candidatePatchSchema.safeParse(formToObject(fd));
  if (!parsed.success) return { error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  try {
    // blank protected fields mean "keep existing" — only send them when something was typed
    const data = { ...parsed.data };
    const clear = [...fd.keys()].filter((k) => fd.get(k) === "");
    await updateCandidate(actor, id, data, { clear, allowSoftDuplicate: fd.get("allowSoftDuplicate") === "on" });
  } catch (e) {
    return handle(e);
  }
  revalidatePath(`/candidates/${id}`);
  revalidatePath("/candidates");
  redirect(`/candidates/${id}`);
}

const noteSchema = z.object({ id: z.string().min(1), text: z.string().trim().min(1).max(4000) });

export async function addNoteAction(_p: CandidateFormState, fd: FormData): Promise<CandidateFormState> {
  const actor = await requireAction("candidates.edit");
  const p = noteSchema.safeParse({ id: fd.get("id"), text: fd.get("text") });
  if (!p.success) return { error: "Enter a note." };
  try {
    await addNote(actor, p.data.id, p.data.text);
  } catch (e) {
    return handle(e);
  }
  revalidatePath(`/candidates/${p.data.id}`);
  return { saved: true };
}

const contactSchema = z.object({
  id: z.string().min(1),
  channel: z.enum(["call", "email", "meeting", "message", "other"]),
  summary: z.string().trim().min(1).max(2000),
});

export async function addContactAction(_p: CandidateFormState, fd: FormData): Promise<CandidateFormState> {
  const actor = await requireAction("candidates.edit");
  const p = contactSchema.safeParse({ id: fd.get("id"), channel: fd.get("channel"), summary: fd.get("summary") });
  if (!p.success) return { error: "Enter a summary." };
  try {
    await addContactEntry(actor, p.data.id, p.data.channel, p.data.summary);
  } catch (e) {
    return handle(e);
  }
  revalidatePath(`/candidates/${p.data.id}`);
  return { saved: true };
}

export async function revealSensitiveAction(candidateId: string, field: "sevisId" | "eadNumber" | "dateOfBirth"): Promise<{ value?: string; error?: string }> {
  try {
    const actor = await requireAction();
    if (!["sevisId", "eadNumber", "dateOfBirth"].includes(field)) return { error: "Unknown field." };
    return { value: await revealSensitive(actor, candidateId, field) };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    throw e;
  }
}

const bulkSchema = z.object({
  ids: z.array(z.string()).min(1, "Select at least one candidate.").max(500, "Select at most 500 candidates at a time."),
  op: z.enum(["assign", "stage", "tag"]),
  value: z.string().optional(),
});

export async function bulkAction(_p: { message?: string; error?: string }, fd: FormData) {
  const actor = await requireAction("candidates.edit");
  const parsed = bulkSchema.safeParse({ ids: fd.getAll("ids"), op: fd.get("op"), value: fd.get("value") ?? undefined });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Select candidates and an action." };
  const { ids, op, value } = parsed.data;
  try {
    const result =
      op === "assign"
        ? await bulkUpdate(actor, ids, { ownerId: value || null })
        : op === "stage"
          ? await bulkUpdate(actor, ids, { stage: value })
          : await bulkUpdate(actor, ids, { addTag: value });
    revalidatePath("/candidates");
    const done = op === "assign" ? (value ? "assigned" : "unassigned") : op === "stage" ? "moved to the new stage" : "tagged";
    const unchanged = result.matched - result.modified;
    return {
      message:
        `${result.matched} candidate${result.matched === 1 ? "" : "s"} ${done}` +
        (unchanged > 0 ? ` (${unchanged} already up to date)` : "") +
        (result.skipped > 0 ? `; ${result.skipped} skipped (not found or not yours to change)` : "") +
        ".",
    };
  } catch (e) {
    if (e instanceof CandidateValidationError || e instanceof ForbiddenError) return { error: e.message };
    throw e;
  }
}
