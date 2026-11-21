import { connectDb } from "@/lib/db/connect";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { MonthlyReview, TrackerCycle, type IMonthlyReview, type ITrackerCycle } from "@/lib/db/models/monthly-review";
import { Task, type ITask } from "@/lib/db/models/task";
import { audit } from "@/lib/audit";
import { loadCandidateFor } from "@/lib/auth/guard";
import type { SessionUser } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/rbac/can";
import { getSetting } from "@/lib/settings";
import { resolveTimezone } from "@/lib/reminders/timezone";
import { upsertSystemTask } from "@/lib/tasks/core";
import { TaskError } from "@/lib/tasks/service";
import { canCloseCycle, defaultAnchorFor, mayStartNextCycle, monthlyRefKey, nextCycleAnchor, planCycle } from "./cycle";
import type { DateOnly } from "@/lib/compliance/dates";

const DISCLAIMER =
  "Internal operational review. This does not replace official DSO / SEVIS reporting; confirm official requirements with the DSO or counsel.";

export interface StartCycleInput {
  candidateId: string;
  /** Explicit anchor (needs tracker.signoff and a recorded reason). Omit to use the default anchor. */
  anchor?: DateOnly;
  anchorReason?: string;
}

/**
 * Start a 12-month cycle. `actor = null` is the system path (candidate onboarding / worker): default anchor, no custom
 * anchor, and only the FIRST cycle (later cycles need a manager or `tracker.autoNextCycle`).
 */
export async function startCycle(actor: SessionUser | null, input: StartCycleInput, opts: { autoNext?: boolean } = {}): Promise<ITrackerCycle> {
  await connectDb();
  let candidate: ICandidate | null;
  if (actor) {
    assertCan(actor, "tracker.edit");
    candidate = await loadCandidateFor(actor, input.candidateId);
  } else {
    candidate = await Candidate.findById(input.candidateId).lean<ICandidate>();
  }
  if (!candidate) throw new TaskError("Candidate not found.", 404);

  const [open, last, autoNextCycle, checklists] = await Promise.all([
    TrackerCycle.findOne({ candidateId: candidate._id, status: "open" }).lean<ITrackerCycle>(),
    TrackerCycle.findOne({ candidateId: candidate._id }).sort({ cycleNumber: -1 }).lean<ITrackerCycle>(),
    getSetting("tracker.autoNextCycle"),
    getSetting("tracker.checklists"),
  ]);
  if (open) throw new TaskError("This candidate already has an open 12-month cycle.", 409);

  const isManager = !!actor && can(actor, "tracker.signoff");
  if (!mayStartNextCycle({ autoNextCycle: !!opts.autoNext || autoNextCycle, triggeredByManager: isManager, hasOpenCycle: false, hasClosedCycle: !!last })) {
    throw new TaskError("A new cycle can only be started by a manager (tracker sign-off) or when automatic next cycles are enabled.", 403);
  }

  const tz = resolveTimezone(candidate.timezone);
  const defaultAnchor = last ? nextCycleAnchor(last.anchorDate) : defaultAnchorFor(candidate, tz);
  const anchor = input.anchor || defaultAnchor;
  const reason =
    input.anchorReason?.trim() ||
    (anchor === defaultAnchor
      ? last
        ? `Continues previous cycle ${last.cycleNumber} (anchor + 12 months).`
        : `Default anchor: ${candidate.eadStart ? "authorization start date" : "compliance onboarding date"}.`
      : "");
  const plan = planCycle({ anchor, anchorReason: reason, defaultAnchor, checklists });
  if (!plan.ok) throw new TaskError(plan.error);
  if (plan.customAnchor && !isManager) {
    throw new TaskError("Only a manager (tracker sign-off permission) can choose a custom anchor date.", 403);
  }

  let cycle: ITrackerCycle;
  try {
    const created = await TrackerCycle.create({
      candidateId: candidate._id,
      cycleNumber: (last?.cycleNumber ?? 0) + 1,
      anchorDate: plan.anchorDate,
      anchorReason: plan.anchorReason,
      anchorChosenBy: plan.customAnchor ? (actor?.id ?? null) : null,
      startedBy: actor?.id ?? null,
    });
    cycle = created.toObject() as ITrackerCycle;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new TaskError("This candidate already has an open 12-month cycle.", 409);
    throw err;
  }

  // one Task per month (idempotent by refKey) + the mirrored monthly_reviews row
  for (const r of plan.reviews) {
    const { task } = await upsertSystemTask({
      candidateId: candidate._id,
      kind: "monthly_review",
      category: "tracker",
      refKey: monthlyRefKey(cycle._id, r.monthNumber),
      title: `Month ${r.monthNumber} operational review`,
      description: DISCLAIMER,
      checklist: r.checklist.map((c) => c.label),
      dueDate: r.dueDate,
      ownerId: candidate.ownerId ?? null,
      meta: { cycleId: cycle._id, monthNumber: r.monthNumber },
      createdBy: actor?.id ?? null,
    });
    await MonthlyReview.updateOne(
      { cycleId: cycle._id, monthNumber: r.monthNumber },
      {
        $setOnInsert: {
          candidateId: candidate._id,
          cycleStart: plan.anchorDate,
          anchorReason: plan.anchorReason,
          dueDate: r.dueDate,
          status: "open",
          checklist: r.checklist,
          taskId: task._id,
        },
      },
      { upsert: true },
    );
  }
  await Candidate.updateOne({ _id: candidate._id }, { $min: { nextDueDate: plan.reviews[0].dueDate } }).catch(() => undefined);

  await audit({
    actor,
    source: actor ? "ui" : "system",
    action: "create",
    entityType: "tracker_cycle",
    entityId: cycle._id,
    candidateId: candidate._id,
    summary: `Started 12-month cycle ${cycle.cycleNumber} anchored ${cycle.anchorDate}`,
    reason: cycle.anchorReason,
    after: { anchorDate: cycle.anchorDate, anchorReason: cycle.anchorReason, custom: plan.customAnchor },
  });
  return cycle;
}

/**
 * Close a cycle after manager review. All 12 months must be completed or waived. Then, only if `tracker.autoNextCycle`
 * is on, the next cycle starts automatically (anchor + 12 months); otherwise a manager starts it explicitly.
 */
export async function closeCycle(actor: SessionUser, cycleId: string, note: string) {
  assertCan(actor, "tracker.signoff");
  await connectDb();
  const cycle = await TrackerCycle.findById(cycleId).lean<ITrackerCycle>();
  if (!cycle || !(await loadCandidateFor(actor, cycle.candidateId))) throw new TaskError("Cycle not found.", 404);
  if (cycle.status !== "open") throw new TaskError("This cycle is already closed.", 409);
  const reviews = await MonthlyReview.find({ cycleId }).lean<IMonthlyReview[]>();
  const check = canCloseCycle({ reviews, hasSignoffPermission: can(actor, "tracker.signoff"), note });
  if (!check.ok) throw new TaskError(check.error);
  const res = await TrackerCycle.updateOne(
    { _id: cycleId, status: "open" },
    { $set: { status: "closed", closedAt: new Date(), closedBy: actor.id, closeNote: note.trim() } },
  );
  if (!res.modifiedCount) throw new TaskError("This cycle is already closed.", 409);
  await audit({
    actor, action: "approve", entityType: "tracker_cycle", entityId: cycleId, candidateId: cycle.candidateId,
    summary: `Manager sign-off: closed 12-month cycle ${cycle.cycleNumber}`, reason: note.trim(),
  });
  let nextStarted = false;
  if (await getSetting("tracker.autoNextCycle")) {
    try {
      await startCycle(null, { candidateId: cycle.candidateId }, { autoNext: true });
      nextStarted = true;
    } catch {
      /* a manager can still start it manually */
    }
  }
  return { nextStarted };
}

/** System step run by the worker: candidates that reached onboarding/active but have no cycle yet get the default cycle. */
/**
 * "On candidate onboarding, create month 1–12 tasks": start the first cycle as soon as a candidate reaches the
 * onboarding/active stage (idempotent — does nothing if any cycle already exists). Failures are logged, never thrown,
 * so a tracker problem can't block saving the candidate.
 */
export async function ensureTrackerCycleFor(candidateId: string): Promise<boolean> {
  try {
    await connectDb();
    const c = await Candidate.findById(candidateId).select("stage").lean<{ stage: string }>();
    if (!c || !["onboarding", "active"].includes(c.stage)) return false;
    if (await TrackerCycle.exists({ candidateId })) return false;
    await startCycle(null, { candidateId });
    return true;
  } catch (e) {
    console.error(`[tracker] could not start first cycle for ${candidateId}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

export async function ensureTrackerCycles(limit = 500): Promise<number> {
  await connectDb();
  const have = await TrackerCycle.distinct("candidateId");
  const rows = await Candidate.find({ stage: { $in: ["onboarding", "active"] }, _id: { $nin: have } })
    .select("_id")
    .limit(limit)
    .lean<{ _id: string }[]>();
  let n = 0;
  for (const r of rows) {
    try {
      await startCycle(null, { candidateId: r._id });
      n++;
    } catch (e) {
      console.error(`[tracker] could not start cycle for ${r._id}:`, e instanceof Error ? e.message : e);
    }
  }
  return n;
}

export interface TrackerCycleView {
  cycle: ITrackerCycle;
  months: { review: IMonthlyReview; task: ITask | null }[];
}

/** Data for the candidate's 12-month tracker tab (caller has already verified candidate access). */
export async function loadTracker(candidateId: string): Promise<TrackerCycleView[]> {
  await connectDb();
  const cycles = await TrackerCycle.find({ candidateId }).sort({ cycleNumber: -1 }).lean<ITrackerCycle[]>();
  if (!cycles.length) return [];
  const reviews = await MonthlyReview.find({ cycleId: { $in: cycles.map((c) => c._id) } }).sort({ monthNumber: 1 }).lean<IMonthlyReview[]>();
  const tasks = await Task.find({ _id: { $in: reviews.map((r) => r.taskId) } }).lean<ITask[]>();
  const byId = new Map(tasks.map((t) => [t._id, t]));
  return cycles.map((cycle) => ({
    cycle,
    months: reviews.filter((r) => r.cycleId === cycle._id).map((review) => ({ review, task: byId.get(review.taskId) ?? null })),
  }));
}
