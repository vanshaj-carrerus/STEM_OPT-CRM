"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAction } from "@/lib/auth/guard";
import { ForbiddenError } from "@/lib/rbac/can";
import { employerFormToObject, employerSchema } from "@/lib/employers/schema";
import { createEmployer, revealEmployerField, updateEmployer } from "@/lib/employers/service";
import { idSchema } from "@/lib/immigration/schema";
import { run, type ActionState } from "@/modules/immigration/action-utils";

export async function createEmployerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let id = "";
  const res = await run(async () => {
    const actor = await requireAction("immigration.edit");
    id = await createEmployer(actor, employerSchema.parse(employerFormToObject(fd)));
    revalidatePath("/employers");
  });
  if (res.error) return res;
  redirect(`/employers/${id}`);
}

export async function updateEmployerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let id = "";
  const res = await run(async () => {
    const actor = await requireAction("immigration.edit");
    id = idSchema.parse(fd.get("id"));
    await updateEmployer(actor, id, employerSchema.parse(employerFormToObject(fd)));
    revalidatePath("/employers");
    revalidatePath(`/employers/${id}`);
  });
  if (res.error) return res;
  redirect(`/employers/${id}`);
}

/** Reveal EIN / E-Verify company ID: permission-checked and audit-logged in the service. */
export async function revealEmployerFieldAction(employerId: string, field: "ein" | "everifyCompanyId"): Promise<{ value?: string; error?: string }> {
  try {
    const actor = await requireAction();
    if (field !== "ein" && field !== "everifyCompanyId") return { error: "Unknown field." };
    return { value: await revealEmployerField(actor, idSchema.parse(employerId), field) };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    throw e;
  }
}
