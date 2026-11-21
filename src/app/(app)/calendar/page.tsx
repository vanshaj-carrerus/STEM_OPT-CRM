import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { listTasks, type TaskRow } from "@/lib/tasks/queries";
import {
  groupByDate,
  monthGrid,
  rangeForView,
  shiftAnchor,
  weekDates,
  type CalendarEntry,
  type CalendarView,
} from "@/lib/tasks/calendar";
import { TASK_CATEGORIES } from "@/lib/tasks/constants";
import { DUE_PRESETS, type DuePreset } from "@/lib/tasks/filters";
import { STATUS_LABELS } from "@/lib/tasks/lifecycle";
import { isDateOnly, todayIn, formatDate, type DateOnly } from "@/lib/compliance/dates";
import { listAssignableUsers } from "@/lib/users/directory";
import { AUTH_TYPE_LABELS } from "@/lib/candidates/constants";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Compliance calendar" };

type SP = { view?: string; date?: string; ownerId?: string; category?: string; authType?: string; status?: string; due?: string };

const VIEWS: { key: CalendarView; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "week", label: "Week" },
  { key: "list", label: "List" },
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CATEGORY_LABELS: Record<string, string> = {
  immigration: "Immigration",
  tracker: "12-month tracker",
  documents: "Documents",
  payroll: "Payroll",
  payments: "Payments",
  general: "General",
};
const KIND_TONE: Record<string, Tone> = {
  milestone: "info",
  monthly_review: "primary",
  change_review: "warning",
  document_request: "neutral",
  unemployment_check: "warning",
  payroll: "neutral",
  payment: "neutral",
  manual: "neutral",
};

const monthTitle = (d: DateOnly) =>
  new Date(`${d.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function entryHref(r: TaskRow) {
  if (!r.candidateId) return null;
  return `/candidates/${r.candidateId}?tab=${r.kind === "monthly_review" ? "tracker" : "tasks"}`;
}

function Chip({ e, href }: { e: CalendarEntry; href: string | null }) {
  const body = (
    <span
      className={cn(
        "block truncate rounded px-1.5 py-0.5 text-[11px] leading-tight",
        e.overdue ? "bg-danger-bg text-danger" : e.status === "completed" ? "bg-success-bg text-success line-through" : "bg-secondary text-secondary-foreground",
      )}
      title={`${e.title}${e.candidateName ? ` — ${e.candidateName}` : ""}`}
    >
      {e.candidateName ? `${e.candidateName.split(" ")[0]}: ` : ""}
      {e.title}
    </span>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePage("tasks.view");
  const sp = await searchParams;
  const today = todayIn(user.timezone);
  // A "due" preset (from a dashboard tile) lists exactly what that tile counted, across all dates.
  const duePreset = (DUE_PRESETS as readonly string[]).includes(sp.due ?? "") ? (sp.due as DuePreset) : undefined;
  const view: CalendarView = duePreset ? "list" : ((["month", "week", "list"] as const).find((v) => v === sp.view) ?? "month");
  const anchor: DateOnly = sp.date && isDateOnly(sp.date) ? sp.date : today;
  const { from, to } = rangeForView(view, anchor);

  const canSeeImmigration = can(user, "immigration.view");
  const [{ rows, total }, owners] = await Promise.all([
    listTasks(
      user,
      {
        due: duePreset,
        dueFrom: duePreset ? undefined : from,
        dueTo: duePreset ? undefined : to,
        ownerId: sp.ownerId || undefined,
        category: (TASK_CATEGORIES as readonly string[]).includes(sp.category ?? "") ? (sp.category as (typeof TASK_CATEGORIES)[number]) : undefined,
        authType: canSeeImmigration ? sp.authType || undefined : undefined,
        status: sp.status || undefined,
      },
      { pageSize: 1000, today },
    ),
    listAssignableUsers(),
  ]);

  const hrefById = new Map(rows.map((r) => [r.id, entryHref(r)]));
  const entries: CalendarEntry[] = rows.map((r) => ({
    id: r.id,
    date: r.dueDate,
    title: r.title,
    kind: r.kind,
    status: r.status,
    overdue: r.overdue,
    candidateId: r.candidateId,
    candidateName: r.candidateName,
  }));
  const byDate = groupByDate(entries);

  const nav = (over: Partial<SP>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) u.set(k, v);
    return `/calendar?${u}`;
  };
  const prev = shiftAnchor(view, anchor, -1);
  const next = shiftAnchor(view, anchor, 1);
  const PRESET_TITLES: Record<DuePreset, string> = {
    today: "Due today", "7d": "Due in the next 7 days", overdue: "Overdue", awaiting_candidate: "Awaiting candidate",
    awaiting_employer: "Awaiting employer", awaiting_dso: "Awaiting DSO", open: "All open work", all: "All tasks",
  };
  const title = duePreset ? PRESET_TITLES[duePreset] : view === "week" ? `${formatDate(from)} – ${formatDate(to)}` : monthTitle(anchor);
  const overdueCount = rows.filter((r) => r.overdue).length;

  return (
    <>
      <PageHeader title="Compliance calendar" description="Milestones, monthly reviews and tasks by due date. Internal due dates only — official DSO windows must be confirmed with the DSO." />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="icon" aria-label="Previous">
              <Link href={nav({ date: prev })}>
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={nav({ date: today })}>Today</Link>
            </Button>
            <Button asChild variant="outline" size="icon" aria-label="Next">
              <Link href={nav({ date: next })}>
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
            <h2 className="ml-2 text-base font-semibold">{title}</h2>
          </div>
          <div className="flex items-center gap-2">
            {overdueCount > 0 && <Badge tone="danger">{overdueCount} overdue in range</Badge>}
            <div className="inline-flex overflow-hidden rounded-md border">
              {VIEWS.map((v) => (
                <Link
                  key={v.key}
                  href={nav({ view: v.key })}
                  aria-current={v.key === view ? "page" : undefined}
                  className={cn("px-3 py-1.5 text-sm", v.key === view ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}
                >
                  {v.label}
                </Link>
              ))}
            </div>
          </div>
        </div>

        <form method="get" className="flex flex-wrap items-end gap-3 border-b px-4 py-3">
          {duePreset && <input type="hidden" name="due" value={duePreset} />}
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="date" value={anchor} />
          <Select name="ownerId" defaultValue={sp.ownerId ?? ""} className="w-44">
            <option value="">All owners</option>
            <option value="unassigned">Unassigned</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Select name="category" defaultValue={sp.category ?? ""} className="w-44">
            <option value="">All categories</option>
            {TASK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c] ?? c}
              </option>
            ))}
          </Select>
          {canSeeImmigration && (
            <Select name="authType" defaultValue={sp.authType ?? ""} className="w-40">
              <option value="">All authorizations</option>
              {Object.entries(AUTH_TYPE_LABELS)
                .filter(([k]) => k !== "none")
                .map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
            </Select>
          )}
          <Select name="status" defaultValue={sp.status ?? ""} className="w-44">
            <option value="">All (except cancelled)</option>
            <option value="open">Open work</option>
            <option value="closed">Completed / waived</option>
            {["waiting_candidate", "waiting_employer", "waiting_dso"].map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s as keyof typeof STATUS_LABELS]}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          <Button asChild variant="ghost">
            <Link href={`/calendar?view=${view}&date=${anchor}`}>Reset</Link>
          </Button>
        </form>

        {total > rows.length && (
          <p className="border-b bg-warning-bg px-4 py-2 text-xs text-warning">Showing the first {rows.length} of {total} items in this range — narrow the filters to see the rest.</p>
        )}

        {view === "month" && (
          <div className="overflow-x-auto">
            <div className="grid min-w-[840px] grid-cols-7 border-b bg-muted/60 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {DOW.map((d) => (
                <div key={d} className="px-2 py-2">
                  {d}
                </div>
              ))}
            </div>
            <div className="min-w-[840px]">
              {monthGrid(anchor).map((week, wi) => (
                <div key={wi} className="grid grid-cols-7 border-b last:border-0">
                  {week.map((d) => {
                    const list = byDate.get(d) ?? [];
                    const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
                    return (
                      <div key={d} className={cn("min-h-28 space-y-1 border-r p-1.5 last:border-r-0", !inMonth && "bg-muted/30 text-muted-foreground")}>
                        <div className="flex items-center justify-between">
                          <Link
                            href={nav({ view: "week", date: d })}
                            className={cn(
                              "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs hover:bg-muted",
                              d === today && "bg-primary font-semibold text-primary-foreground hover:bg-primary",
                            )}
                          >
                            {Number(d.slice(8))}
                          </Link>
                          {list.length > 0 && <span className="text-[10px] text-muted-foreground">{list.length}</span>}
                        </div>
                        {list.slice(0, 3).map((e) => (
                          <Chip key={e.id} e={e} href={hrefById.get(e.id) ?? null} />
                        ))}
                        {list.length > 3 && (
                          <Link href={nav({ view: "week", date: d })} className="block text-[11px] text-primary hover:underline">
                            +{list.length - 3} more
                          </Link>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "week" && (
          <div className="overflow-x-auto">
            <div className="grid min-w-[840px] grid-cols-7">
              {weekDates(anchor).map((d, i) => {
                const list = byDate.get(d) ?? [];
                return (
                  <div key={d} className="min-h-72 space-y-1.5 border-r p-2 last:border-r-0">
                    <div className={cn("mb-2 text-xs font-semibold", d === today ? "text-primary" : "text-muted-foreground")}>
                      {DOW[i]} {Number(d.slice(8))}
                    </div>
                    {list.map((e) => (
                      <Chip key={e.id} e={e} href={hrefById.get(e.id) ?? null} />
                    ))}
                    {list.length === 0 && <p className="text-[11px] text-muted-foreground">—</p>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {view === "list" &&
          (byDate.size === 0 ? (
            <EmptyState title="Nothing due in this period" description="Try another month or clear the filters." />
          ) : (
            <ul className="divide-y">
              {[...byDate.entries()].map(([d, list]) => (
                <li key={d} className="flex gap-4 px-4 py-3">
                  <div className={cn("w-28 shrink-0 text-sm font-medium", d === today && "text-primary")}>{formatDate(d)}</div>
                  <ul className="flex-1 space-y-2">
                    {list.map((e) => {
                      const row = rows.find((r) => r.id === e.id)!;
                      const href = hrefById.get(e.id);
                      return (
                        <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <Badge tone={KIND_TONE[e.kind] ?? "neutral"}>{e.kind.replace("_", " ")}</Badge>
                          {href ? (
                            <Link href={href} className="font-medium text-primary hover:underline">
                              {e.title}
                            </Link>
                          ) : (
                            <span className="font-medium">{e.title}</span>
                          )}
                          {e.candidateName && <span className="text-muted-foreground">· {e.candidateName}</span>}
                          {row.ownerName && <span className="text-xs text-muted-foreground">({row.ownerName})</span>}
                          <Badge tone={e.overdue ? "danger" : e.status === "completed" ? "success" : "neutral"}>
                            {e.overdue ? "Overdue" : STATUS_LABELS[e.status as keyof typeof STATUS_LABELS] ?? e.status}
                          </Badge>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          ))}
      </Card>
    </>
  );
}
