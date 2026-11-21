"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAction } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { PayrollError, toActionError, type ActionResult } from "@/lib/payroll/errors";
import { decideOverride, flagEmergency, linkEmergencyToBatch, requestOverride, resolveEmergency, updateEmergency } from "@/lib/payroll/emergency";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { loadCandidateFor } from "@/lib/auth/guard";
import { connectDb } from "@/lib/db/connect";

const s = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

async function exec(paths: string[], fn: (actor: SessionUser) => Promise<string | void>): Promise<ActionResult> {
  try {
    const actor = await requireAction();
    const message = await fn(actor);
    for (const p of paths) revalidatePath(p);
    return { ok: true, message: message || undefined };
  } catch (e) {
    return toActionError(e);
  }
}

const paths = (id?: string) => ["/emergency-payroll", ...(id ? [`/emergency-payroll/${id}`] : []), "/payroll", "/dashboard"];

/** Flag by candidate id (candidate tab) or by candidate code, e.g. CND-000123 (queue page). Record-level access is enforced. */
export async function flagEmergencyAction(_p: ActionResult, fd: FormData): Promise<ActionResult> {
  let newId = "";
  const redirectTo = s(fd, "redirectTo");
  const r = await exec(["/emergency-payroll", "/dashboard"], async (actor) => {
    let candidateId = s(fd, "candidateId");
    if (!candidateId) {
      await connectDb();
      const code = s(fd, "candidateCode").trim().toUpperCase();
      const c = code ? await Candidate.findOne({ candidateCode: code }).select("_id").lean<ICandidate>() : null;
      const visible = c ? await loadCandidateFor(actor, c._id) : null;
      if (!visible) throw new PayrollError("Candidate code not found.", 404);
      candidateId = visible._id;
    }
    const item = await flagEmergency(actor, {
      candidateId, reason: s(fd, "reason"), requestedPayDate: s(fd, "requestedPayDate"),
      ownerId: s(fd, "ownerId") || undefined, priority: (s(fd, "priority") || "high") as "high", batchId: s(fd, "batchId") || undefined,
    });
    newId = item._id;
    revalidatePath(`/candidates/${candidateId}`);
  });
  if (r.error) return r;
  if (redirectTo === "item") redirect(`/emergency-payroll/${newId}`);
  return { ok: true, message: "Flagged for emergency payroll." };
}

export async function updateEmergencyAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "id");
  return exec(paths(id), async (a) => {
    await updateEmergency(a, id, {
      reason: s(fd, "reason") || undefined, requestedPayDate: s(fd, "requestedPayDate") || undefined,
      ownerId: s(fd, "ownerId") || undefined, priority: (s(fd, "priority") || undefined) as "high" | undefined,
    });
    return "Updated.";
  });
}

export async function linkBatchAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "id");
  return exec(paths(id), async (a) => {
    await linkEmergencyToBatch(a, id, s(fd, "batchId"));
    return "Linked to payroll batch.";
  });
}

export async function requestOverrideAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "id");
  return exec(paths(id), async (a) => {
    await requestOverride(a, id, { kind: s(fd, "kind") as "exception", reason: s(fd, "reason") });
    return "Request sent to a manager with override rights for approval.";
  });
}

export async function decideOverrideAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "id");
  return exec(paths(id), async (a) => {
    await decideOverride(a, id, { decision: s(fd, "decision") as "approve", note: s(fd, "note") || undefined });
    return s(fd, "decision") === "approve" ? "Override approved." : "Override rejected.";
  });
}

export async function resolveEmergencyAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "id");
  return exec(paths(id), async (a) => {
    await resolveEmergency(a, id, { note: s(fd, "note") || undefined });
    return "Resolved and removed from the active queue. History is kept on the candidate record.";
  });
}
