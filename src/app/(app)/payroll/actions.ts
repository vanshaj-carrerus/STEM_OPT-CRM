"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAction } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { toActionError, type ActionResult } from "@/lib/payroll/errors";
import {
  approveBatch, createBatch, createCorrectionBatch, markBatchFailed, markSubmittedToProvider, reconcileBatch, recordProviderEvidence,
  rejectBatch, removeItem, reopenFailed, saveItem, setItemExcluded, submitForReview, voidBatch,
} from "@/lib/payroll/batches";
import { clearPayrollMapping, updatePayrollMapping } from "@/lib/payroll/mapping";
import { commitRegisterImport, previewRegisterImport, type ImportPreview } from "@/lib/payroll/import";
import { runGustoSync } from "@/lib/payroll/sync";

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

const batchPaths = (id: string) => [`/payroll/${id}`, "/payroll", "/emergency-payroll", "/dashboard"];

/* ------------------------------- batches ------------------------------- */

export async function createBatchAction(_p: ActionResult, fd: FormData): Promise<ActionResult> {
  let id = "";
  const r = await exec(["/payroll"], async (actor) => {
    const b = await createBatch(actor, {
      payPeriod: { start: s(fd, "start"), end: s(fd, "end"), payDate: s(fd, "payDate") },
      companyRef: s(fd, "companyRef") || undefined,
      notes: s(fd, "notes") || undefined,
    });
    id = b._id;
  });
  if (r.error) return r;
  redirect(`/payroll/${id}`);
}

export async function submitReviewAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await submitForReview(a, id);
    return "Submitted for review. A different approver must approve it.";
  });
}

export async function rejectBatchAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await rejectBatch(a, id, s(fd, "reason"));
    return "Batch returned to Draft for changes.";
  });
}

export async function approveBatchAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await approveBatch(a, id);
    return "Batch approved.";
  });
}

export async function markSubmittedAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await markSubmittedToProvider(a, id, { externalRef: s(fd, "externalRef") });
    return "Recorded as submitted to Gusto (Processing).";
  });
}

export async function evidenceAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await recordProviderEvidence(a, id, {
      externalRef: s(fd, "externalRef"), processedDate: s(fd, "processedDate"), payStatementRef: s(fd, "payStatementRef"), note: s(fd, "note"),
    });
    return "Provider evidence recorded. Payroll is Completed-Pending-Reconciliation.";
  });
}

export async function markFailedAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await markBatchFailed(a, id, s(fd, "reason"));
    return "Recorded as failed.";
  });
}

export async function reopenFailedAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await reopenFailed(a, id);
    return "Batch reopened for correction.";
  });
}

export async function voidBatchAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await voidBatch(a, id, s(fd, "reason"));
    return "Batch voided.";
  });
}

export async function correctionBatchAction(_p: ActionResult, fd: FormData): Promise<ActionResult> {
  let newId = "";
  const r = await exec(["/payroll"], async (a) => {
    newId = (await createCorrectionBatch(a, s(fd, "batchId"), s(fd, "reason")))._id;
  });
  if (r.error) return r;
  redirect(`/payroll/${newId}`);
}

/* -------------------------------- items -------------------------------- */

export async function saveItemAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await saveItem(a, id, {
      candidateId: s(fd, "candidateId"),
      hours: s(fd, "hours"),
      payType: (s(fd, "payType") || "hourly") as "hourly",
      gross: s(fd, "gross"), net: s(fd, "net"), bonuses: s(fd, "bonuses"), deductions: s(fd, "deductions"), adjustments: s(fd, "adjustments"),
      adjustmentNote: s(fd, "adjustmentNote") || undefined,
    });
    return "Item saved.";
  });
}

export async function excludeItemAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await setItemExcluded(a, id, s(fd, "itemId"), { exclude: s(fd, "exclude") === "1", reason: s(fd, "reason") });
  });
}

export async function removeItemAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    await removeItem(a, id, s(fd, "itemId"));
  });
}

/* ----------------------------- reconciliation ----------------------------- */

export async function reconcileAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "batchId");
  return exec(batchPaths(id), async (a) => {
    const { result } = await reconcileBatch(a, id, {
      providerTotal: s(fd, "providerTotal"), settlementTotal: s(fd, "settlementTotal"), settlementReference: s(fd, "settlementReference"), note: s(fd, "note") || undefined,
    });
    return result.status === "reconciled" ? "Reconciled." : result.status === "mismatch" ? `Mismatch recorded — an exception task was created. ${result.reasons.join(" ")}` : `Still pending. ${result.reasons.join(" ")}`;
  });
}

/* ------------------------------ CSV import ------------------------------ */

export async function previewImportAction(batchId: string, csv: string): Promise<{ error?: string; preview?: ImportPreview }> {
  try {
    const actor = await requireAction();
    return { preview: await previewRegisterImport(actor, String(batchId), String(csv)) };
  } catch (e) {
    return { error: toActionError(e).error };
  }
}

export async function commitImportAction(batchId: string, csv: string): Promise<ActionResult> {
  return exec(batchPaths(String(batchId)), async (a) => {
    const { counts } = await commitRegisterImport(a, String(batchId), String(csv));
    return `Imported: ${counts.created} new, ${counts.updated} updated, ${counts.unmatched + counts.ambiguous} unmatched (flagged), ${counts.skippedErrors} rejected.`;
  });
}

/* ----------------------------- mapping & sync ----------------------------- */

export async function mappingAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "candidateId");
  return exec(["/payroll", `/candidates/${id}`], async (a) => {
    await updatePayrollMapping(a, {
      candidateId: id, employeeId: s(fd, "employeeId"), companyRef: s(fd, "companyRef"), paySchedule: s(fd, "paySchedule"), payType: s(fd, "payType") as "hourly",
    });
    return "Mapping saved.";
  });
}

export async function clearMappingAction(_p: ActionResult, fd: FormData) {
  const id = s(fd, "candidateId");
  return exec(["/payroll", `/candidates/${id}`], async (a) => {
    await clearPayrollMapping(a, id, s(fd, "reason"));
    return "Mapping removed.";
  });
}

export async function syncAction(_p: ActionResult, fd: FormData) {
  return exec(["/payroll"], async (a) => {
    const batchId = s(fd, "batchId");
    const r = await runGustoSync(a, batchId ? { batchId } : { period: { start: s(fd, "start"), end: s(fd, "end") } });
    return r.messages.join(" ") || `Checked ${r.checked}, applied ${r.applied}.`;
  });
}
