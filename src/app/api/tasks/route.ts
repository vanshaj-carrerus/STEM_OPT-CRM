import { NextResponse, type NextRequest } from "next/server";
import { route } from "@/lib/api";
import { assertCan } from "@/lib/rbac/can";
import { listTasks } from "@/lib/tasks/queries";
import { DUE_PRESETS, type DuePreset, type TaskFilters } from "@/lib/tasks/filters";
import { TASK_CATEGORIES, type TaskCategory } from "@/lib/tasks/constants";
import { isDateOnly } from "@/lib/compliance/dates";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks?due=today|7d|overdue|awaiting_candidate|awaiting_employer|awaiting_dso|open|all
 *   &status=&ownerId=&category=&kind=&candidateId=&authType=&dueFrom=&dueTo=&page=&pageSize=
 * Scoped to the candidates the caller may access (same rule as candidate lists) and to the task categories their role may see.
 */
export const GET = route(async (user, req: NextRequest) => {
  assertCan(user, "tasks.view");
  const sp = req.nextUrl.searchParams;
  const due = sp.get("due");
  const category = sp.get("category");
  const dueFrom = sp.get("dueFrom");
  const dueTo = sp.get("dueTo");
  const filters: TaskFilters = {
    due: due && (DUE_PRESETS as readonly string[]).includes(due) ? (due as DuePreset) : undefined,
    status: sp.get("status") || undefined,
    ownerId: sp.get("ownerId") || undefined,
    category: category && (TASK_CATEGORIES as readonly string[]).includes(category) ? (category as TaskCategory) : undefined,
    kind: sp.get("kind") || undefined,
    candidateId: sp.get("candidateId") || undefined,
    authType: sp.get("authType") || undefined,
    dueFrom: dueFrom && isDateOnly(dueFrom) ? dueFrom : undefined,
    dueTo: dueTo && isDateOnly(dueTo) ? dueTo : undefined,
  };
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize")) || 50));
  const res = await listTasks(user, filters, { page, pageSize });
  return NextResponse.json(res);
});
