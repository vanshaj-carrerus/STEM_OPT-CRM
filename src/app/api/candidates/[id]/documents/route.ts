import { NextResponse, type NextRequest } from "next/server";
import { apiError, route } from "@/lib/api";
import { loadCandidateFor } from "@/lib/auth/guard";
import { assertCan } from "@/lib/rbac/can";
import { MAX_UPLOAD_BYTES } from "@/lib/storage";
import { uploadMetaSchema } from "@/lib/documents/schema";
import { DocumentError, listCandidateDocuments, uploadDocument } from "@/lib/documents/service";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/candidates/{id}/documents — latest versions + history (restricted categories trimmed). */
export const GET = route(async (user, _req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  try {
    const groups = await listCandidateDocuments(user, id);
    await audit({ actor: user, action: "read", entityType: "document", candidateId: id, source: "api", summary: "Viewed document list via API" });
    return NextResponse.json({ documents: groups });
  } catch (e) {
    if (e instanceof DocumentError) return apiError(e.status, e.message);
    throw e;
  }
});

/**
 * POST /api/candidates/{id}/documents — multipart upload: `file` + type/groupId/title/employerId/issueDate/expiryDate.
 * Sending an existing `groupId` creates the next version of that document. Route handlers (unlike server actions)
 * are not subject to the 1 MB action body limit.
 */
export const POST = route(
  async (user, req: NextRequest, ctx: Ctx) => {
    const { id } = await ctx.params;
    assertCan(user, "documents.upload");
    if (!(await loadCandidateFor(user, id))) return apiError(404, "Candidate not found");

    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      return apiError(415, "Send the document as multipart/form-data");
    }
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES + 1024 * 1024) return apiError(413, "File exceeds the 15 MB limit.");

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return apiError(400, "Choose a file to upload.");
    if (file.size > MAX_UPLOAD_BYTES) return apiError(413, "File exceeds the 15 MB limit.");

    const fields: Record<string, string> = {};
    for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
    const meta = uploadMetaSchema.parse(fields);

    try {
      const doc = await uploadDocument(user, id, { fileName: file.name, data: Buffer.from(await file.arrayBuffer()), meta });
      return NextResponse.json(doc, { status: 201 });
    } catch (e) {
      if (e instanceof DocumentError) return apiError(e.status, e.message);
      throw e;
    }
  },
  { limitPerMin: 60 },
);
