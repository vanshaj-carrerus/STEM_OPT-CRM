import { NextResponse, type NextRequest } from "next/server";
import { apiError, route } from "@/lib/api";
import { rateLimit } from "@/lib/auth/ratelimit";
import { assertCan } from "@/lib/rbac/can";
import { exportCandidates, EXPORT_MAX_ROWS, type CandidateListQuery } from "@/lib/candidates/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/candidates/export — CSV of the candidates matching the SAME filters as the list (q, stage, authType, ownerId,
 * tag, dueBefore, risk), limited to the caller's access scope. Restricted identifiers (SEVIS ID, EAD number, date of birth)
 * are excluded unless `includeSensitive=1` AND the caller holds that field's permission. Every export is audit-logged.
 */
export const GET = route(async (user, req: NextRequest) => {
  assertCan(user, "candidates.export");
  const rl = await rateLimit(`export:${user.id}`, 10, 60);
  if (!rl.allowed) return apiError(429, "Too many exports. Please wait a minute.", { retryAfterSec: rl.retryAfterSec });

  const sp = req.nextUrl.searchParams;
  const q: CandidateListQuery = {
    q: sp.get("q") ?? undefined,
    stage: sp.get("stage") || undefined,
    authType: sp.get("authType") || undefined,
    ownerId: sp.get("ownerId") || undefined,
    tag: sp.get("tag") || undefined,
    dueBefore: sp.get("dueBefore") || undefined,
    risk: sp.get("risk") === "1",
  };
  const out = await exportCandidates(user, q, { includeSensitive: sp.get("includeSensitive") === "1" });
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse("﻿" + out.csv, {
    // BOM so Excel opens UTF-8 names (accents) correctly
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="candidates-${date}.csv"`,
      "Cache-Control": "no-store",
      "X-Export-Count": String(out.count),
      "X-Export-Truncated": out.truncated ? `true (limit ${EXPORT_MAX_ROWS})` : "false",
    },
  });
});
