import { NextResponse, type NextRequest } from "next/server";
import { apiError, route } from "@/lib/api";
import { IMPORT_MAX_BYTES } from "@/lib/import/parse";
import { createImportPreview } from "@/lib/import/service";
import { importErrorResponse } from "@/lib/import/http";
import { assertCan } from "@/lib/rbac/can";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/candidates/import — multipart `file` (.csv / .xlsx, max 5 MB / 5,000 rows).
 * Returns { jobId, headers, mapping, summary, rows, ... }: a PREVIEW only. Nothing is created until
 * POST /api/candidates/import/{jobId}/commit.
 */
export const POST = route(
  async (user, req: NextRequest) => {
    assertCan(user, "candidates.import");
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      return apiError(415, "Send the roster as multipart/form-data");
    }
    if (Number(req.headers.get("content-length") ?? 0) > IMPORT_MAX_BYTES + 512 * 1024) return apiError(413, "The file is larger than the 5 MB limit.");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return apiError(400, "Choose a .csv or .xlsx file.");
    if (file.size > IMPORT_MAX_BYTES) return apiError(413, "The file is larger than the 5 MB limit.");
    try {
      const preview = await createImportPreview(user, file.name, Buffer.from(await file.arrayBuffer()));
      return NextResponse.json(preview, { status: 201 });
    } catch (e) {
      const res = importErrorResponse(e);
      if (res) return res;
      throw e;
    }
  },
  { limitPerMin: 20 },
);
