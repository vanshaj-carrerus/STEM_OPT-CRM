"use server";

import { revalidatePath } from "next/cache";
import { requireAction } from "@/lib/auth/guard";
import { employmentSchema, endEmploymentSchema } from "@/lib/employment/schema";
import { createEmployment, endEmployment, setCurrentEmployer, updateEmployment } from "@/lib/employment/service";
import { idSchema } from "@/lib/immigration/schema";
import { formToObject, run, type ActionState } from "../immigration/action-utils";

const refresh = (candidateId: string) => {
  revalidatePath(`/candidates/${candidateId}`);
};

/** Create (no recordId) or edit an employment record. Material changes raise change-review tasks inside the service. */
export async function saveEmploymentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("candidates.edit");
    const candidateId = idSchema.parse(fd.get("candidateId"));
    const recordId = fd.get("recordId") ? idSchema.parse(fd.get("recordId")) : null;
    const input = employmentSchema.parse({ ...formToObject(fd), setAsCurrent: fd.get("setAsCurrent") === "on" });
    if (recordId) await updateEmployment(actor, candidateId, recordId, input);
    else await createEmployment(actor, candidateId, input);
    refresh(candidateId);
  });
}

export async function endEmploymentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("candidates.edit");
    const candidateId = idSchema.parse(fd.get("candidateId"));
    const { endDate } = endEmploymentSchema.parse({ endDate: fd.get("endDate") });
    await endEmployment(actor, candidateId, idSchema.parse(fd.get("recordId")), endDate);
    refresh(candidateId);
  });
}

export async function setCurrentEmployerAction(candidateId: string, employerId: string | null): Promise<ActionState> {
  return run(async () => {
    const actor = await requireAction("candidates.edit");
    await setCurrentEmployer(actor, idSchema.parse(candidateId), employerId ? idSchema.parse(employerId) : null);
    refresh(candidateId);
  });
}
