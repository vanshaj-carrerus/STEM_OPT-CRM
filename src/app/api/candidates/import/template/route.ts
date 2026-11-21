import { type NextRequest } from "next/server";
import { route } from "@/lib/api";
import { assertCan } from "@/lib/rbac/can";
import { csvEscape } from "@/lib/csv";
import { TEMPLATE_HEADERS } from "@/lib/import/fields";

export const dynamic = "force-dynamic";

/** GET /api/candidates/import/template — header-only CSV (deliberately no sample people). */
export const GET = route(async (user, _req: NextRequest) => {
  assertCan(user, "candidates.import");
  return new Response(TEMPLATE_HEADERS.map(csvEscape).join(",") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="candidate-import-template.csv"',
      "Cache-Control": "no-store",
    },
  });
});
