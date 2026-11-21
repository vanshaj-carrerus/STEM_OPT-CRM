import { NextResponse, type NextRequest } from "next/server";
import { route } from "@/lib/api";
import { cancelImport } from "@/lib/import/service";
import { importErrorResponse } from "@/lib/import/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ jobId: string }> };

/** DELETE /api/candidates/import/{jobId} — cancel a previewed import and wipe its stored rows. */
export const DELETE = route(async (user, _req: NextRequest, ctx: Ctx) => {
  const { jobId } = await ctx.params;
  try {
    await cancelImport(user, jobId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const res = importErrorResponse(e);
    if (res) return res;
    throw e;
  }
});
