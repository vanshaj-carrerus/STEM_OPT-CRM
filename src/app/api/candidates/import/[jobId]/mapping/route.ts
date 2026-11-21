import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api";
import { remapImport } from "@/lib/import/service";
import { importErrorResponse } from "@/lib/import/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ jobId: string }> };

const body = z.object({ mapping: z.array(z.string().max(40).nullable()).max(100) });

/** POST /api/candidates/import/{jobId}/mapping — adjust column mapping; returns a fresh validated preview. */
export const POST = route(
  async (user, req: NextRequest, ctx: Ctx) => {
    const { jobId } = await ctx.params;
    const { mapping } = body.parse(await req.json());
    try {
      return NextResponse.json(await remapImport(user, jobId, mapping));
    } catch (e) {
      const res = importErrorResponse(e);
      if (res) return res;
      throw e;
    }
  },
  { limitPerMin: 30 },
);
