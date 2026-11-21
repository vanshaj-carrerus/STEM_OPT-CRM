import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api";
import { commitImport } from "@/lib/import/service";
import { importErrorResponse } from "@/lib/import/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // each row goes through createCandidate() sequentially

type Ctx = { params: Promise<{ jobId: string }> };

const body = z.object({
  confirmMasterRoster: z.literal(true, { error: "Confirm that this is the approved master roster." }),
  duplicateHandling: z.enum(["skip", "import_soft"]).default("skip"),
});

/**
 * POST /api/candidates/import/{jobId}/commit — { confirmMasterRoster: true, duplicateHandling?: "skip" | "import_soft" }.
 * Duplicates and invalid rows are reported per row and never abort the batch.
 */
export const POST = route(
  async (user, req: NextRequest, ctx: Ctx) => {
    const { jobId } = await ctx.params;
    const parsed = body.parse(await req.json());
    try {
      const result = await commitImport(user, jobId, parsed);
      return NextResponse.json(result);
    } catch (e) {
      const res = importErrorResponse(e);
      if (res) return res;
      throw e;
    }
  },
  { limitPerMin: 10 },
);
