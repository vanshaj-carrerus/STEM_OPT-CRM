"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireAction } from "@/lib/auth/guard";
import { ForbiddenError } from "@/lib/rbac/can";
import { closeCycle, startCycle } from "@/lib/tracker/service";
import { TaskError } from "@/lib/tasks/service";

export interface TrackerFormState {
  error?: string;
  saved?: boolean;
  message?: string;
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

function fail(e: unknown): TrackerFormState {
  if (e instanceof TaskError || e instanceof ForbiddenError) return { error: e.message };
  if (e instanceof ZodError) return { error: e.issues[0]?.message ?? "Please check the form." };
  throw e;
}

/** "Start cycle": default anchor for everyone with tracker.edit; a custom anchor needs tracker.signoff + a recorded reason. */
export async function startCycleAction(_p: TrackerFormState, fd: FormData): Promise<TrackerFormState> {
  const candidateId = str(fd, "candidateId");
  try {
    const actor = await requireAction("tracker.edit");
    await startCycle(actor, { candidateId, anchor: str(fd, "anchor") || undefined, anchorReason: str(fd, "anchorReason") || undefined });
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/candidates/${candidateId}`);
  revalidatePath("/calendar");
  return { saved: true };
}

/** Manager sign-off: closes the cycle once all 12 months are completed/waived. */
export async function closeCycleAction(_p: TrackerFormState, fd: FormData): Promise<TrackerFormState> {
  const candidateId = str(fd, "candidateId");
  try {
    const actor = await requireAction("tracker.signoff");
    const res = await closeCycle(actor, str(fd, "cycleId"), str(fd, "note"));
    revalidatePath(`/candidates/${candidateId}`);
    revalidatePath("/calendar");
    return { saved: true, message: res.nextStarted ? "Cycle closed and the next cycle started." : "Cycle closed." };
  } catch (e) {
    return fail(e);
  }
}
