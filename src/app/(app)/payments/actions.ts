"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireAction } from "@/lib/auth/guard";
import { ForbiddenError } from "@/lib/rbac/can";
import { SeparationOfDutiesError } from "@/lib/sod";
import { PaymentError } from "@/lib/payments/errors";
import { MoneyError } from "@/lib/payments/money";
import { linkedEventSchema, paymentInputSchema, reasonSchema, reconcileSchema, submissionSchema } from "@/lib/payments/schema";
import { approvePayment, cancelPayment, createPayment, previewRisk, rejectPayment, submitForApproval, updateDraftPayment } from "@/lib/payments/service";
import { flagBeneficiaryMismatch, markFailed, markPaid, markProcessing, recordLinkedEvent, recordSubmission, reconcilePayment, reversePayment } from "@/lib/payments/execution";
import { mintReceiptDownload } from "@/lib/payments/receipts";

export interface PaymentFormState {
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
  saved?: boolean;
}

const obj = (fd: FormData) => {
  const o: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") o[k] = v;
  return o;
};
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

function toState(e: unknown): PaymentFormState {
  if (e instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const i of e.issues) fieldErrors[String(i.path[0] ?? "form")] ??= i.message;
    return { error: e.issues[0]?.message ?? "Please check the form.", fieldErrors };
  }
  if (e instanceof PaymentError) return { error: e.message, fieldErrors: e.fieldErrors };
  if (e instanceof MoneyError || e instanceof ForbiddenError || e instanceof SeparationOfDutiesError) return { error: e.message };
  throw e;
}

/* ------------------------------ create / edit ------------------------------ */

export async function createPaymentAction(_p: PaymentFormState, fd: FormData): Promise<PaymentFormState> {
  let id: string;
  try {
    const actor = await requireAction("payments.prepare");
    const input = paymentInputSchema.parse(obj(fd));
    // the hidden idempotency token makes a double-click / retried submit return the same draft
    const { payment } = await createPayment(actor, input, { requestKey: str(fd, "requestKey") || undefined });
    id = payment._id;
  } catch (e) {
    return toState(e);
  }
  revalidatePath("/payments");
  redirect(`/payments/${id}`);
}

export async function updatePaymentAction(_p: PaymentFormState, fd: FormData): Promise<PaymentFormState> {
  const id = str(fd, "id");
  try {
    const actor = await requireAction("payments.prepare");
    await updateDraftPayment(actor, id, paymentInputSchema.parse(obj(fd)));
  } catch (e) {
    return toState(e);
  }
  revalidatePath("/payments");
  redirect(`/payments/${id}`);
}

/** Live high-risk indicator for the form (no writes). Returns null on incomplete input. */
export async function previewRiskAction(values: Record<string, string>) {
  try {
    const actor = await requireAction("payments.prepare");
    const input = paymentInputSchema.parse(values);
    return { ok: true as const, ...(await previewRisk(actor, input, { excludePaymentId: values.paymentId || undefined })) };
  } catch (e) {
    const st = e instanceof ZodError || e instanceof PaymentError || e instanceof MoneyError ? toState(e) : { error: "Unavailable" };
    return { ok: false as const, error: st.error ?? "Incomplete", fieldErrors: st.fieldErrors };
  }
}

/* ------------------------------- state commands ------------------------------- */

/** One audited entry point per workflow step. Authorization is re-checked inside every service function. */
export async function paymentCommandAction(_p: PaymentFormState, fd: FormData): Promise<PaymentFormState> {
  const id = str(fd, "id");
  const command = str(fd, "command");
  try {
    const actor = await requireAction("payments.view");
    switch (command) {
      case "submit_for_approval":
        await submitForApproval(actor, id);
        break;
      case "approve": {
        const r = await approvePayment(actor, id, str(fd, "note") || undefined);
        revalidatePath(`/payments/${id}`);
        revalidatePath("/payments");
        return { saved: true, message: r.finalized ? "Payment approved." : `Approval recorded (${r.progress.count} of ${r.progress.required}). A different approver must also approve.` };
      }
      case "reject":
        await rejectPayment(actor, id, reasonSchema.parse(str(fd, "reason")));
        break;
      case "record_submission": {
        const v = submissionSchema.parse({ providerReference: str(fd, "providerReference"), note: str(fd, "note") || undefined });
        await recordSubmission(actor, id, v);
        break;
      }
      case "processing":
        await markProcessing(actor, id, str(fd, "note") || undefined);
        break;
      case "paid":
        await markPaid(actor, id, { note: str(fd, "note") || undefined, paidAt: str(fd, "paidAt") || undefined });
        break;
      case "failed":
        await markFailed(actor, id, reasonSchema.parse(str(fd, "reason")));
        break;
      case "cancel":
        await cancelPayment(actor, id, reasonSchema.parse(str(fd, "reason")));
        break;
      case "reverse":
        await reversePayment(actor, id, reasonSchema.parse(str(fd, "reason")));
        break;
      case "linked":
        await recordLinkedEvent(actor, id, linkedEventSchema.parse({ kind: str(fd, "kind"), amount: str(fd, "amount"), reason: str(fd, "reason"), providerReference: str(fd, "providerReference") }));
        break;
      case "mismatch":
        await flagBeneficiaryMismatch(actor, id, reasonSchema.parse(str(fd, "reason")));
        break;
      case "reconcile":
        await reconcilePayment(actor, id, reconcileSchema.parse({
          statementRef: str(fd, "statementRef"), settledAmount: str(fd, "settledAmount"), statementDate: str(fd, "statementDate"),
          note: str(fd, "note") || undefined, mismatchResolution: str(fd, "mismatchResolution") || undefined,
        }));
        break;
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    return toState(e);
  }
  revalidatePath(`/payments/${id}`);
  revalidatePath("/payments");
  revalidatePath("/dashboard");
  return { saved: true, message: "Saved." };
}

/* --------------------------------- evidence --------------------------------- */

/** Permission-checked: mints the 60-second, user-bound download link (the download route audits the access). */
export async function mintReceiptDownloadAction(receiptId: string): Promise<{ url?: string; error?: string }> {
  try {
    const actor = await requireAction("payments.view");
    const { url } = await mintReceiptDownload(actor, receiptId);
    return { url };
  } catch (e) {
    const s = toState(e);
    return { error: s.error };
  }
}
