"use server";

import { revalidatePath } from "next/cache";
import { requireAction } from "@/lib/auth/guard";
import { ForbiddenError } from "@/lib/rbac/can";
import { SeparationOfDutiesError } from "@/lib/sod";
import { reviewSchema } from "@/lib/documents/schema";
import { DocumentError, mintDownloadUrl, reviewDocument } from "@/lib/documents/service";

export interface DownloadState {
  url?: string;
  error?: string;
}

/**
 * Mint a short-lived (60 s) signed link for one document. Permission (documents.download), record-level candidate
 * access and the restricted-category rule are enforced in the service; the download route re-checks all of it.
 */
export async function requestDownloadUrl(documentId: string, inline = false): Promise<DownloadState> {
  try {
    const actor = await requireAction("documents.download");
    if (typeof documentId !== "string" || !documentId) return { error: "Document not found." };
    return { url: await mintDownloadUrl(actor, documentId, inline === true) };
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof DocumentError) return { error: e.message };
    throw e;
  }
}

export interface ReviewState {
  error?: string;
  saved?: boolean;
}

export async function reviewDocumentAction(_prev: ReviewState, fd: FormData): Promise<ReviewState> {
  try {
    const actor = await requireAction("documents.verify");
    const parsed = reviewSchema.safeParse({
      documentId: fd.get("documentId"),
      decision: fd.get("decision"),
      note: fd.get("note") ?? undefined,
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid review." };
    const doc = await reviewDocument(actor, parsed.data);
    revalidatePath(`/candidates/${doc.candidateId}`);
    revalidatePath("/documents");
    return { saved: true };
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof DocumentError || e instanceof SeparationOfDutiesError) return { error: e.message };
    throw e;
  }
}
