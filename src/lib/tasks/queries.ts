import { connectDb } from "@/lib/db/connect";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { Task, OPEN_TASK_STATUSES, type ITask } from "@/lib/db/models/task";
import { User, type IUser } from "@/lib/db/models/user";
import { can, candidateScopeFilter, type Actor } from "@/lib/rbac/can";
import { todayIn, type DateOnly } from "@/lib/compliance/dates";
import { DEFAULT_TIMEZONE, isValidTimezone } from "@/lib/reminders/timezone";
import {
  WIDGET_PRESETS,
  buildTaskQuery,
  visibleCategories,
  type TaskFilters,
  type TaskScope,
  type WidgetCounts,
} from "./filters";
import { isOverdue } from "./calendar";

type QueryActor = Actor & { timezone?: string };

const todayFor = (actor: QueryActor, today?: DateOnly) =>
  today ?? todayIn(isValidTimezone(actor.timezone) ? actor.timezone : DEFAULT_TIMEZONE);

/** Record-level scope for tasks: same rule as candidateScopeFilter, plus per-module category visibility. */
export async function taskScopeFor(actor: Actor): Promise<TaskScope | null> {
  if (!can(actor, "tasks.view")) return null;
  await connectDb();
  const canSeeCandidates = can(actor, "candidates.view");
  const all = canSeeCandidates && can(actor, "candidates.viewAll");
  const candidateIds =
    all || !canSeeCandidates ? [] : ((await Candidate.find(candidateScopeFilter(actor)).distinct("_id")) as string[]);
  return { actorId: actor.id, all, candidateIds, categories: visibleCategories(actor) };
}

async function authTypeIds(actor: Actor, scope: TaskScope, authType: string): Promise<string[]> {
  const filter = (scope.all ? { authType } : { authType, _id: { $in: scope.candidateIds } }) as Record<string, unknown>;
  return (await Candidate.find(filter).distinct("_id")) as string[];
}

/** Drop filters the actor may not use (authorization type needs immigration.view). */
function sanitizeFilters(actor: Actor, f: TaskFilters): TaskFilters {
  const out = { ...f };
  if (out.authType && !can(actor, "immigration.view")) delete out.authType;
  return out;
}

async function queryFor(actor: QueryActor, f: TaskFilters, today?: DateOnly) {
  const scope = await taskScopeFor(actor);
  if (!scope) return null;
  const filters = sanitizeFilters(actor, f);
  const ids = filters.authType ? await authTypeIds(actor, scope, filters.authType) : undefined;
  return { query: buildTaskQuery(filters, { today: todayFor(actor, today), scope }, ids), scope, today: todayFor(actor, today) };
}

export interface TaskRow {
  id: string;
  title: string;
  kind: ITask["kind"];
  category: ITask["category"];
  status: ITask["status"];
  priority: ITask["priority"];
  dueDate: DateOnly;
  originalDueDate: DateOnly;
  ownerId: string | null;
  ownerName?: string;
  candidateId: string | null;
  candidateName?: string;
  candidateCode?: string;
  overdue: boolean;
  checklistDone: number;
  checklistTotal: number;
  snoozeCount: number;
}

export interface TaskList {
  rows: TaskRow[];
  total: number;
  page: number;
  pageSize: number;
  today: DateOnly;
}

/**
 * Tasks the actor may see, filtered. `total` is exactly what the matching dashboard widget counts (AC-18):
 * both are built from the same `buildTaskQuery` + presets.
 */
export async function listTasks(
  actor: QueryActor,
  filters: TaskFilters = {},
  opts: { page?: number; pageSize?: number; today?: DateOnly } = {},
): Promise<TaskList> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(1000, Math.max(1, opts.pageSize ?? 50));
  const q = await queryFor(actor, filters, opts.today);
  if (!q) return { rows: [], total: 0, page, pageSize, today: todayFor(actor, opts.today) };

  const [tasks, total] = await Promise.all([
    Task.find(q.query)
      .sort({ dueDate: 1, title: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<ITask[]>(),
    Task.countDocuments(q.query),
  ]);

  const candIds = [...new Set(tasks.map((t) => t.candidateId).filter((x): x is string => !!x))];
  const ownerIds = [...new Set(tasks.map((t) => t.ownerId).filter((x): x is string => !!x))];
  const [cands, owners] = await Promise.all([
    candIds.length ? Candidate.find({ _id: { $in: candIds } }).select("legalName candidateCode").lean<ICandidate[]>() : [],
    ownerIds.length ? User.find({ _id: { $in: ownerIds } }).select("name").lean<IUser[]>() : [],
  ]);
  const cMap = new Map(cands.map((c) => [c._id, c]));
  const oMap = new Map(owners.map((o) => [o._id, o.name]));

  return {
    total, page, pageSize, today: q.today,
    rows: tasks.map((t) => ({
      id: t._id, title: t.title, kind: t.kind, category: t.category, status: t.status, priority: t.priority,
      dueDate: t.dueDate, originalDueDate: t.originalDueDate, ownerId: t.ownerId ?? null,
      ownerName: t.ownerId ? oMap.get(t.ownerId) : undefined,
      candidateId: t.candidateId,
      candidateName: t.candidateId ? cMap.get(t.candidateId)?.legalName : undefined,
      candidateCode: t.candidateId ? cMap.get(t.candidateId)?.candidateCode : undefined,
      overdue: isOverdue(t.status, t.dueDate, q.today),
      checklistDone: t.checklist.filter((c) => c.done).length,
      checklistTotal: t.checklist.length,
      snoozeCount: t.snoozes.length,
    })),
  };
}

/** Dashboard widgets. Each count equals `listTasks(actor, { due: <preset> }).total` for the same actor and day. */
export async function taskWidgetCounts(actor: QueryActor, extra: TaskFilters = {}, today?: DateOnly): Promise<WidgetCounts> {
  const zero: WidgetCounts = { dueToday: 0, due7Days: 0, overdue: 0, awaitingCandidate: 0, awaitingEmployer: 0, awaitingDso: 0 };
  const scope = await taskScopeFor(actor);
  if (!scope) return zero;
  const t = todayFor(actor, today);
  const filters = sanitizeFilters(actor, extra);
  const ids = filters.authType ? await authTypeIds(actor, scope, filters.authType) : undefined;
  const out = { ...zero };
  await Promise.all(
    (Object.entries(WIDGET_PRESETS) as [keyof WidgetCounts, TaskFilters["due"]][]).map(async ([key, due]) => {
      out[key] = await Task.countDocuments(buildTaskQuery({ ...filters, due }, { today: t, scope }, ids));
    }),
  );
  return out;
}

/** Candidates with at least one open overdue task the actor can see (dashboard "at risk" widget). */
export async function candidatesAtRisk(actor: QueryActor, today?: DateOnly): Promise<{ count: number; candidateIds: string[] }> {
  const q = await queryFor(actor, { due: "overdue" }, today);
  if (!q) return { count: 0, candidateIds: [] };
  const ids = ((await Task.distinct("candidateId", q.query)) as (string | null)[]).filter((x): x is string => !!x);
  return { count: ids.length, candidateIds: ids };
}

/* ---------------------------- monthly reviews ---------------------------- */

export interface MonthlyStats {
  /** completed (not waived) monthly reviews */
  completed: number;
  /** open reviews not yet overdue */
  due: number;
  /** open reviews past their due date */
  overdue: number;
  byOwner: { ownerId: string | null; ownerName?: string; completed: number; due: number; overdue: number }[];
}

/** Pure aggregation so reports and tests share it. */
export function computeMonthlyStats(tasks: Pick<ITask, "status" | "dueDate" | "ownerId">[], today: DateOnly): MonthlyStats {
  const stats: MonthlyStats = { completed: 0, due: 0, overdue: 0, byOwner: [] };
  const owners = new Map<string | null, MonthlyStats["byOwner"][number]>();
  for (const t of tasks) {
    const key = t.ownerId ?? null;
    const o = owners.get(key) ?? { ownerId: key, completed: 0, due: 0, overdue: 0 };
    owners.set(key, o);
    if (t.status === "completed") {
      stats.completed++;
      o.completed++;
    } else if (OPEN_TASK_STATUSES.includes(t.status)) {
      if (isOverdue(t.status, t.dueDate, today)) {
        stats.overdue++;
        o.overdue++;
      } else {
        stats.due++;
        o.due++;
      }
    }
  }
  stats.byOwner = [...owners.values()].sort((a, b) => b.overdue - a.overdue || (a.ownerId ?? "").localeCompare(b.ownerId ?? ""));
  return stats;
}

/** 12-month tracker numbers for reports (needs tracker.view; scoped to accessible candidates). */
export async function monthlyReviewStats(actor: QueryActor, today?: DateOnly): Promise<MonthlyStats> {
  if (!can(actor, "tracker.view")) return { completed: 0, due: 0, overdue: 0, byOwner: [] };
  const q = await queryFor(actor, { kind: "monthly_review", status: "all" }, today);
  if (!q) return { completed: 0, due: 0, overdue: 0, byOwner: [] };
  const tasks = await Task.find(q.query).select("status dueDate ownerId").lean<ITask[]>();
  const stats = computeMonthlyStats(tasks, q.today);
  const ids = stats.byOwner.map((o) => o.ownerId).filter((x): x is string => !!x);
  if (ids.length) {
    const users = await User.find({ _id: { $in: ids } }).select("name").lean<IUser[]>();
    const names = new Map(users.map((u) => [u._id, u.name]));
    for (const o of stats.byOwner) o.ownerName = o.ownerId ? names.get(o.ownerId) : undefined;
  }
  return stats;
}

/**
 * Full task documents for ONE candidate (notes, snoozes, evidence...) for the candidate Tasks tab.
 * Callers must already have verified candidate access (`loadCandidateFor`); category visibility is applied here.
 */
export async function candidateTasksDetail(actor: Actor, candidateId: string, opts: { includeMonthly?: boolean } = {}): Promise<ITask[]> {
  if (!can(actor, "tasks.view") && !can(actor, "tracker.view")) return [];
  await connectDb();
  const cats = visibleCategories(actor).filter((c) => can(actor, "tasks.view") || c === "tracker");
  const rows = await Task.find({
    candidateId,
    category: { $in: cats },
    ...(opts.includeMonthly ? {} : { kind: { $ne: "monthly_review" } }),
  }).lean<ITask[]>();
  const open = rows.filter((t) => OPEN_TASK_STATUSES.includes(t.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const closed = rows
    .filter((t) => !OPEN_TASK_STATUSES.includes(t.status))
    .sort((a, b) => (b.completedAt?.getTime() ?? b.updatedAt.getTime()) - (a.completedAt?.getTime() ?? a.updatedAt.getTime()));
  return [...open, ...closed];
}
