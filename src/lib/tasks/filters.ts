import { addDays, compareDates, type DateOnly } from "@/lib/compliance/dates";
import { OPEN_TASK_STATUSES, TASK_CATEGORIES, TASK_STATUSES, type TaskCategory, type TaskStatus } from "./constants";
import type { ITask } from "@/lib/db/models/task";
import { can, type Actor } from "@/lib/rbac/can";
import type { Permission } from "@/lib/rbac/permissions";

/**
 * ONE definition of every task filter, used both to build the Mongo query (`buildTaskQuery`) and to filter
 * in-memory fixtures (`matchesTask`). Dashboard widget counts are derived from the same presets, so they reconcile
 * exactly with `listTasks()` results (AC-18).
 */

export const DUE_PRESETS = ["today", "7d", "overdue", "awaiting_candidate", "awaiting_employer", "awaiting_dso", "open", "all"] as const;
export type DuePreset = (typeof DUE_PRESETS)[number];

export interface TaskFilters {
  due?: DuePreset;
  /** A TaskStatus, or the groups "open" / "closed" / "all". */
  status?: string;
  /** User id or "unassigned". */
  ownerId?: string;
  category?: TaskCategory;
  kind?: string;
  candidateId?: string;
  /** Candidate authorization type (needs immigration.view). Resolved to candidate ids by the caller. */
  authType?: string;
  /** Inclusive date-only range (calendar views). */
  dueFrom?: DateOnly;
  dueTo?: DateOnly;
}

export interface FilterSpec {
  statuses: TaskStatus[];
  dueFrom?: DateOnly;
  dueTo?: DateOnly;
}

const CLOSED: TaskStatus[] = ["completed", "waived", "cancelled"];
/** Default list: everything except cancelled work. */
const DEFAULT_STATUSES: TaskStatus[] = TASK_STATUSES.filter((s) => s !== "cancelled");

function presetSpec(due: DuePreset, today: DateOnly): Partial<FilterSpec> {
  switch (due) {
    case "today":
      return { statuses: [...OPEN_TASK_STATUSES], dueFrom: today, dueTo: today };
    case "7d": // today through today+7, inclusive
      return { statuses: [...OPEN_TASK_STATUSES], dueFrom: today, dueTo: addDays(today, 7) };
    case "overdue":
      return { statuses: [...OPEN_TASK_STATUSES], dueTo: addDays(today, -1) };
    case "awaiting_candidate":
      return { statuses: ["waiting_candidate"] };
    case "awaiting_employer":
      return { statuses: ["waiting_employer"] };
    case "awaiting_dso":
      return { statuses: ["waiting_dso"] };
    case "open":
      return { statuses: [...OPEN_TASK_STATUSES] };
    default:
      return {};
  }
}

function statusSet(status: string | undefined): TaskStatus[] | null {
  if (!status) return null;
  if (status === "open") return [...OPEN_TASK_STATUSES];
  if (status === "closed") return [...CLOSED];
  if (status === "all") return [...TASK_STATUSES];
  const list = status.split(",").filter((s): s is TaskStatus => (TASK_STATUSES as readonly string[]).includes(s));
  return list.length ? list : [];
}

/** Resolve preset + explicit status + range into one effective spec. */
export function resolveSpec(f: TaskFilters, today: DateOnly): FilterSpec {
  const preset = f.due ? presetSpec(f.due, today) : {};
  const explicit = statusSet(f.status);
  let statuses: TaskStatus[] = preset.statuses ?? explicit ?? DEFAULT_STATUSES;
  if (preset.statuses && explicit) statuses = preset.statuses.filter((s) => explicit.includes(s));
  let dueFrom = preset.dueFrom;
  let dueTo = preset.dueTo;
  if (f.dueFrom && (!dueFrom || compareDates(f.dueFrom, dueFrom) > 0)) dueFrom = f.dueFrom;
  if (f.dueTo && (!dueTo || compareDates(f.dueTo, dueTo) < 0)) dueTo = f.dueTo;
  return { statuses, dueFrom, dueTo };
}

/* ------------------------------- scope ------------------------------- */

/** Which tasks the actor may see. Mirrors candidateScopeFilter + per-module visibility. */
export interface TaskScope {
  actorId: string;
  /** candidates.viewAll: every candidate's tasks and every candidate-less task. */
  all: boolean;
  /** When !all: ids of the candidates the actor can access. */
  candidateIds: string[];
  categories: TaskCategory[];
}

const CATEGORY_PERMISSION: Record<TaskCategory, Permission | null> = {
  immigration: "immigration.view",
  tracker: "tracker.view",
  documents: "documents.view",
  payroll: "payroll.view",
  payments: "payments.view",
  general: null,
};

/** Task categories the actor's role may see (a payroll preparer must not see immigration tasks, etc.). */
export function visibleCategories(actor: Actor): TaskCategory[] {
  return TASK_CATEGORIES.filter((c) => {
    const p = CATEGORY_PERMISSION[c];
    return p === null || can(actor, p);
  });
}

export function taskInScope(t: Pick<ITask, "candidateId" | "category" | "ownerId" | "createdBy">, s: TaskScope): boolean {
  if (!s.categories.includes(t.category)) return false;
  if (t.candidateId) return s.all || s.candidateIds.includes(t.candidateId);
  return s.all || t.ownerId === s.actorId || t.createdBy === s.actorId;
}

/* ----------------------------- in-memory ----------------------------- */

export interface MatchContext {
  today: DateOnly;
  scope: TaskScope;
  /** candidateId -> authType, only needed when filtering by authType. */
  candidateAuthType?: ReadonlyMap<string, string>;
}

type Matchable = Pick<ITask, "candidateId" | "category" | "ownerId" | "createdBy" | "status" | "dueDate" | "kind">;

export function matchesTask(t: Matchable, f: TaskFilters, ctx: MatchContext): boolean {
  if (!taskInScope(t, ctx.scope)) return false;
  const spec = resolveSpec(f, ctx.today);
  if (!spec.statuses.includes(t.status)) return false;
  if (spec.dueFrom && compareDates(t.dueDate, spec.dueFrom) < 0) return false;
  if (spec.dueTo && compareDates(t.dueDate, spec.dueTo) > 0) return false;
  if (f.ownerId) {
    if (f.ownerId === "unassigned" ? !!t.ownerId : t.ownerId !== f.ownerId) return false;
  }
  if (f.category && t.category !== f.category) return false;
  if (f.kind && t.kind !== f.kind) return false;
  if (f.candidateId && t.candidateId !== f.candidateId) return false;
  if (f.authType) {
    if (!t.candidateId || ctx.candidateAuthType?.get(t.candidateId) !== f.authType) return false;
  }
  return true;
}

export function filterTasks<T extends Matchable>(tasks: T[], f: TaskFilters, ctx: MatchContext): T[] {
  return tasks.filter((t) => matchesTask(t, f, ctx));
}

/* ------------------------------ widgets ------------------------------ */

export interface WidgetCounts {
  dueToday: number;
  due7Days: number;
  overdue: number;
  awaitingCandidate: number;
  awaitingEmployer: number;
  awaitingDso: number;
}

/** Each dashboard widget IS a `listTasks({ due })` call — this map is the single source of truth. */
export const WIDGET_PRESETS: Record<keyof WidgetCounts, DuePreset> = {
  dueToday: "today",
  due7Days: "7d",
  overdue: "overdue",
  awaitingCandidate: "awaiting_candidate",
  awaitingEmployer: "awaiting_employer",
  awaitingDso: "awaiting_dso",
};

export function computeWidgetCounts(tasks: Matchable[], ctx: MatchContext, extra: TaskFilters = {}): WidgetCounts {
  const out = {} as WidgetCounts;
  for (const [key, due] of Object.entries(WIDGET_PRESETS) as [keyof WidgetCounts, DuePreset][]) {
    out[key] = filterTasks(tasks, { ...extra, due }, ctx).length;
  }
  return out;
}

/* ------------------------------- mongo ------------------------------- */

/** Mongo query equivalent of `matchesTask` (scope + filters). `candidateIdsForAuth` is the pre-resolved authType set. */
export function buildTaskQuery(f: TaskFilters, ctx: Pick<MatchContext, "today" | "scope">, candidateIdsForAuth?: string[]) {
  const { scope } = ctx;
  const spec = resolveSpec(f, ctx.today);
  const and: Record<string, unknown>[] = [{ category: { $in: scope.categories } }, { status: { $in: spec.statuses } }];

  if (!scope.all) {
    and.push({
      $or: [
        { candidateId: { $in: scope.candidateIds } },
        { candidateId: null, $or: [{ ownerId: scope.actorId }, { createdBy: scope.actorId }] },
      ],
    });
  }
  if (spec.dueFrom || spec.dueTo) {
    const r: Record<string, string> = {};
    if (spec.dueFrom) r.$gte = spec.dueFrom;
    if (spec.dueTo) r.$lte = spec.dueTo;
    and.push({ dueDate: r });
  }
  if (f.ownerId) and.push({ ownerId: f.ownerId === "unassigned" ? null : f.ownerId });
  if (f.category) and.push({ category: f.category });
  if (f.kind) and.push({ kind: f.kind });
  if (f.candidateId) and.push({ candidateId: f.candidateId });
  if (f.authType) and.push({ candidateId: { $in: candidateIdsForAuth ?? [] } });
  return { $and: and };
}
