import { describe, expect, it } from "vitest";
import { groupByDate, monthGrid, rangeForView, shiftAnchor, weekDates, type CalendarEntry } from "@/lib/tasks/calendar";
import {
  computeWidgetCounts, filterTasks, matchesTask, buildTaskQuery, visibleCategories, WIDGET_PRESETS,
  type MatchContext, type TaskScope,
} from "@/lib/tasks/filters";
import { computeMonthlyStats } from "@/lib/tasks/queries";
import type { TaskStatus, TaskCategory, TaskKind } from "@/lib/tasks/constants";

describe("calendar grouping", () => {
  it("month grid is Sunday-first, whole weeks, covers the month", () => {
    const g = monthGrid("2026-12-15");
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g[0][0]).toBe("2026-11-29"); // Dec 1 2026 is a Tuesday
    expect(g.flat()).toContain("2026-12-31");
    expect(g[g.length - 1][6]).toBe("2027-01-02");
  });
  it("week, range and navigation", () => {
    expect(weekDates("2026-12-09")[0]).toBe("2026-12-06");
    expect(rangeForView("list", "2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(rangeForView("week", "2026-12-09")).toEqual({ from: "2026-12-06", to: "2026-12-12" });
    expect(shiftAnchor("month", "2026-12-15", 1)).toBe("2027-01-01");
    expect(shiftAnchor("week", "2026-12-15", -1)).toBe("2026-12-08");
  });
  it("groups by date, overdue first, deterministic order", () => {
    const e = (id: string, date: string, title: string, overdue = false): CalendarEntry => ({ id, date, title, kind: "manual", status: "open", overdue, candidateId: null });
    const m = groupByDate([e("3", "2026-12-02", "B"), e("1", "2026-12-01", "Z"), e("2", "2026-12-02", "A"), e("4", "2026-12-02", "C", true)]);
    expect([...m.keys()]).toEqual(["2026-12-01", "2026-12-02"]);
    expect(m.get("2026-12-02")!.map((x) => x.id)).toEqual(["4", "2", "3"]);
  });
});

type T = { id: string; candidateId: string | null; category: TaskCategory; ownerId: string | null; createdBy: string | null; status: TaskStatus; dueDate: string; kind: TaskKind };
const TODAY = "2026-12-10";
let n = 0;
const t = (over: Partial<T>): T => ({ id: `t${++n}`, candidateId: "c1", category: "immigration", ownerId: "u1", createdBy: null, status: "open", dueDate: TODAY, kind: "milestone", ...over });
const fixtures: T[] = [
  t({ dueDate: TODAY }),
  t({ dueDate: TODAY, status: "in_progress" }),
  t({ dueDate: "2026-12-13" }),
  t({ dueDate: "2026-12-17" }), // exactly +7 → included in 7d
  t({ dueDate: "2026-12-18" }), // +8 → excluded
  t({ dueDate: "2026-12-01" }), // overdue
  t({ dueDate: "2026-12-09", status: "waiting_candidate" }), // overdue + awaiting candidate
  t({ dueDate: "2027-02-01", status: "waiting_employer" }),
  t({ dueDate: "2027-03-01", status: "waiting_dso" }),
  t({ dueDate: "2026-12-01", status: "completed" }), // never counts as open/overdue
  t({ dueDate: "2026-12-01", status: "waived" }),
  t({ dueDate: "2026-12-01", status: "cancelled" }),
  t({ candidateId: "c2", dueDate: "2026-11-01" }), // candidate the actor cannot access
  t({ candidateId: "c1", category: "payroll", dueDate: "2026-11-01" }), // category hidden for this role
  t({ candidateId: null, category: "general", ownerId: "me", dueDate: "2026-11-02" }),
  t({ candidateId: null, category: "general", ownerId: "someone", createdBy: "else", dueDate: "2026-11-02" }), // not mine
];
const scope: TaskScope = { actorId: "me", all: false, candidateIds: ["c1"], categories: ["immigration", "tracker", "general"] };
const ctx: MatchContext = { today: TODAY, scope };

describe("widget counts reconcile with the task filter (AC-18)", () => {
  const counts = computeWidgetCounts(fixtures, ctx);
  it("expected values", () => {
    expect(counts).toEqual({ dueToday: 2, due7Days: 4, overdue: 3, awaitingCandidate: 1, awaitingEmployer: 1, awaitingDso: 1 });
  });
  it("each widget equals the length of the matching list filter", () => {
    for (const [key, due] of Object.entries(WIDGET_PRESETS)) {
      expect(counts[key as keyof typeof counts]).toBe(filterTasks(fixtures, { due }, ctx).length);
    }
  });
  it("reconciles under extra filters too (owner)", () => {
    const extra = { ownerId: "me" } as const;
    const c = computeWidgetCounts(fixtures, ctx, extra);
    expect(c.overdue).toBe(filterTasks(fixtures, { ...extra, due: "overdue" }, ctx).length);
    expect(c.overdue).toBe(1); // the general task owned by "me"
  });
  it("record-level scope: inaccessible candidates, hidden categories and others' general tasks are invisible", () => {
    const all = filterTasks(fixtures, { status: "all" }, ctx);
    expect(all.some((x) => x.candidateId === "c2")).toBe(false);
    expect(all.some((x) => x.category === "payroll")).toBe(false);
    expect(all.filter((x) => x.candidateId === null)).toHaveLength(1);
    expect(matchesTask(fixtures[0], {}, { today: TODAY, scope: { ...scope, candidateIds: [] } })).toBe(false);
  });
  it("viewAll scope sees every candidate; default list hides cancelled", () => {
    const wide = { today: TODAY, scope: { ...scope, all: true, categories: ["immigration", "payroll", "general", "tracker"] as TaskCategory[] } };
    expect(filterTasks(fixtures, {}, wide).some((x) => x.status === "cancelled")).toBe(false);
    expect(filterTasks(fixtures, { due: "overdue" }, wide).some((x) => x.candidateId === "c2")).toBe(true);
  });
  it("range + status filters (calendar) and unassigned owner", () => {
    expect(filterTasks(fixtures, { dueFrom: "2026-12-10", dueTo: "2026-12-13", status: "open" }, ctx)).toHaveLength(3);
    expect(filterTasks([t({ ownerId: null })], { ownerId: "unassigned" }, ctx)).toHaveLength(1);
  });
});

describe("mongo query mirrors the same definitions", () => {
  it("scopes by candidate, category and status; overdue preset has an upper date bound", () => {
    const q = buildTaskQuery({ due: "overdue" }, { today: TODAY, scope }) as { $and: Record<string, unknown>[] };
    const flat = JSON.stringify(q);
    expect(flat).toContain('"category":{"$in":["immigration","tracker","general"]}');
    expect(flat).toContain('"candidateId":{"$in":["c1"]}');
    expect(flat).toContain('"dueDate":{"$lte":"2026-12-09"}');
    expect(flat).toContain('"waiting_dso"');
    expect(flat).not.toContain('"completed"');
  });
  it("viewAll adds no candidate restriction", () => {
    const q = JSON.stringify(buildTaskQuery({ due: "today" }, { today: TODAY, scope: { ...scope, all: true } }));
    expect(q).not.toContain("candidateId");
  });
  it("visibleCategories hides module tasks from roles without that module", () => {
    expect(visibleCategories({ id: "p", role: "payroll_preparer" })).toEqual(["payroll", "general"]);
    expect(visibleCategories({ id: "c", role: "compliance_associate" })).toEqual(["immigration", "tracker", "documents", "general"]);
  });
});

describe("monthly review stats", () => {
  it("counts completed / due / overdue overall and by owner", () => {
    const s = computeMonthlyStats(
      [
        { status: "completed", dueDate: "2026-11-01", ownerId: "a" },
        { status: "open", dueDate: "2026-12-20", ownerId: "a" },
        { status: "in_progress", dueDate: "2026-12-01", ownerId: "b" },
        { status: "waived", dueDate: "2026-10-01", ownerId: "b" },
        { status: "open", dueDate: "2026-12-01", ownerId: null },
      ],
      TODAY,
    );
    expect(s).toMatchObject({ completed: 1, due: 1, overdue: 2 });
    expect(s.byOwner.find((o) => o.ownerId === "a")).toMatchObject({ completed: 1, due: 1, overdue: 0 });
    expect(s.byOwner.find((o) => o.ownerId === "b")).toMatchObject({ completed: 0, overdue: 1 });
  });
});
