import { NextResponse, type NextRequest } from "next/server";
import { route, pageParams } from "@/lib/api";
import { candidateCreateSchema } from "@/lib/candidates/schema";
import { createCandidate, listCandidates, toCandidateView } from "@/lib/candidates/service";

export const dynamic = "force-dynamic";

/** GET /api/candidates — search/filter/paginate (record-level scoped, field-trimmed). */
export const GET = route(async (user, req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pageParams(sp);
  const result = await listCandidates(user, {
    q: sp.get("q") ?? undefined,
    stage: sp.get("stage") ?? undefined,
    authType: sp.get("authType") ?? undefined,
    ownerId: sp.get("ownerId") ?? undefined,
    tag: sp.get("tag") ?? undefined,
    dueBefore: sp.get("dueBefore") ?? undefined,
    risk: sp.get("risk") === "1",
    sort: (sp.get("sort") as never) ?? undefined,
    page,
    pageSize,
  });
  return NextResponse.json(result);
});

/** POST /api/candidates — create; 409 with matches on duplicate (add ?allowSoftDuplicate=1 to override name+DOB matches). */
export const POST = route(async (user, req: NextRequest) => {
  const body = candidateCreateSchema.parse(await req.json());
  const created = await createCandidate(user, body, { allowSoftDuplicate: req.nextUrl.searchParams.get("allowSoftDuplicate") === "1" });
  return NextResponse.json(toCandidateView(user, created), { status: 201 });
});
