"use server";

import { revalidatePath } from "next/cache";
import { requireAction } from "@/lib/auth/guard";
import { authorizationPeriodSchema, i983Schema, idSchema, reasonSchema, unemploymentSchema } from "@/lib/immigration/schema";
import { createPeriod, deletePeriod, unverifyPeriod, updatePeriod, verifyPeriod } from "@/lib/immigration/service";
import { saveI983, verifyI983 } from "@/lib/immigration/i983-service";
import { addUnemployment, deleteUnemployment, verifyUnemployment } from "@/lib/immigration/unemployment-service";
import { grantClearance, revokeClearance } from "@/lib/immigration/clearance-service";
import { regenerateSchedule } from "@/lib/immigration/schedule";
import { requireCandidate } from "@/lib/immigration/access";
import { run, formToObject, type ActionState } from "./action-utils";

/**
 * Server actions for the Immigration tab. Every action re-checks the permission server-side (requireAction) and the
 * services re-check record-level candidate access; hiding buttons in the UI is never relied on.
 */

const refresh = (candidateId: string) => revalidatePath(`/candidates/${candidateId}`);

/** Create (no periodId) or edit an authorization period. */
export async function savePeriodAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.edit");
    const candidateId = idSchema.parse(fd.get("candidateId"));
    const periodId = fd.get("periodId") ? idSchema.parse(fd.get("periodId")) : null;
    const input = authorizationPeriodSchema.parse(formToObject(fd));
    if (periodId) await updatePeriod(actor, candidateId, periodId, input);
    else await createPeriod(actor, candidateId, input);
    refresh(candidateId);
  });
}

export async function deletePeriodAction(candidateId: string, periodId: string): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.edit");
    await deletePeriod(actor, idSchema.parse(candidateId), idSchema.parse(periodId));
    refresh(candidateId);
  });
}

export async function verifyPeriodAction(candidateId: string, periodId: string): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.verify");
    await verifyPeriod(actor, idSchema.parse(candidateId), idSchema.parse(periodId));
    refresh(candidateId);
  });
}

/** Un-verify (default) or reject a period; a reason is mandatory. */
export async function unverifyPeriodAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.verify");
    const candidateId = idSchema.parse(fd.get("candidateId"));
    const as = fd.get("as") === "rejected" ? "rejected" : "unverified";
    await unverifyPeriod(actor, candidateId, idSchema.parse(fd.get("periodId")), reasonSchema.parse(fd.get("reason")), as);
    refresh(candidateId);
  });
}

export async function saveI983Action(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.edit");
    const candidateId = idSchema.parse(fd.get("candidateId"));
    await saveI983(actor, candidateId, idSchema.parse(fd.get("periodId")), i983Schema.parse(formToObject(fd)));
    refresh(candidateId);
  });
}

export async function verifyI983Action(candidateId: string, periodId: string): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.verify");
    await verifyI983(actor, idSchema.parse(candidateId), idSchema.parse(periodId));
    refresh(candidateId);
  });
}

export async function addUnemploymentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.edit");
    const candidateId = idSchema.parse(fd.get("candidateId"));
    await addUnemployment(actor, candidateId, unemploymentSchema.parse(formToObject(fd)));
    refresh(candidateId);
  });
}

export async function verifyUnemploymentAction(candidateId: string, periodId: string): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.verify");
    await verifyUnemployment(actor, idSchema.parse(candidateId), idSchema.parse(periodId));
    refresh(candidateId);
  });
}

export async function deleteUnemploymentAction(candidateId: string, periodId: string): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.edit");
    await deleteUnemployment(actor, idSchema.parse(candidateId), idSchema.parse(periodId));
    refresh(candidateId);
  });
}

/** "Clear to work": allowed only when evaluateClearance passes with verified evidence, by an `immigration.verify` holder. */
export async function clearToWorkAction(candidateId: string): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.verify");
    await grantClearance(actor, idSchema.parse(candidateId));
    refresh(candidateId);
    return { saved: true, message: "Cleared to work. Evidence, reviewer and time were recorded." };
  });
}

export async function revokeClearanceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.verify");
    const candidateId = idSchema.parse(fd.get("candidateId"));
    await revokeClearance(actor, candidateId, reasonSchema.parse(fd.get("reason")));
    refresh(candidateId);
  });
}

/** Re-run milestone generation + clearance re-check (e.g. after evidence was verified/un-verified in Documents). */
export async function recheckAction(candidateId: string): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("immigration.edit");
    const id = idSchema.parse(candidateId);
    await requireCandidate(actor, id);
    const r = await regenerateSchedule({ actor, candidateId: id });
    refresh(id);
    return {
      saved: true,
      message: `Re-checked: ${r.created} created, ${r.updated} updated, ${r.reopened} reopened, ${r.cancelled} cancelled${r.clearanceRevoked ? "; clearance was revoked" : ""}.`,
    };
  });
}
