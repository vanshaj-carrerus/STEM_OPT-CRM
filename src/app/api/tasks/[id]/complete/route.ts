import { NextResponse, type NextRequest } from "next/server";
import { apiError, route } from "@/lib/api";
import { TaskError, completeSchema, completeTask } from "@/lib/tasks/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/tasks/{id}/complete — { outcome, evidenceNote?, documentId?, checklistWaiverReason? }. Audited; needs tasks.edit (tracker.edit for monthly reviews). */
export const POST = route(async (user, req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = completeSchema.parse(await req.json());
  try {
    const t = await completeTask(user, id, body);
    return NextResponse.json({ id: t._id, status: t.status, completedAt: t.completedAt, outcome: t.outcome });
  } catch (e) {
    if (e instanceof TaskError) return apiError(e.status, e.message);
    throw e;
  }
});
