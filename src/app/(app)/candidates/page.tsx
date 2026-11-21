import type { Metadata } from "next";
import Link from "next/link";
import { Download, Plus, Upload, Bookmark, X } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { connectDb } from "@/lib/db/connect";
import { SavedView, type ISavedView } from "@/lib/db/models/saved-view";
import { listCandidates, type CandidateListQuery } from "@/lib/candidates/service";
import { listAssignableUsers, userNameMap } from "@/lib/users/directory";
import { todayIn } from "@/lib/compliance/dates";
import { AUTH_TYPE_LABELS, CANDIDATE_STAGES, STAGE_LABELS } from "@/lib/db/models/candidate";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { CandidateTable, type Row } from "./candidate-table";
import { deleteViewAction, saveViewAction } from "./views-actions";

export const metadata: Metadata = { title: "Candidates" };

type SP = Record<string, string | undefined>;

export default async function CandidatesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePage("candidates.view");
  const sp = await searchParams;
  const q: CandidateListQuery = {
    q: sp.q,
    stage: sp.stage || undefined,
    authType: sp.authType || undefined,
    ownerId: sp.ownerId || undefined,
    tag: sp.tag || undefined,
    dueBefore: sp.dueBefore || undefined,
    risk: sp.risk === "1",
    sort: (sp.sort as CandidateListQuery["sort"]) || "-created",
    page: Number(sp.page) || 1,
    pageSize: 25,
  };
  const [{ rows, total, page, pageSize }, owners] = await Promise.all([listCandidates(user, q), listAssignableUsers()]);
  const names = await userNameMap(rows.map((r) => r.ownerId as string | null));
  await connectDb();
  const views = await SavedView.find({ userId: user.id, module: "candidates" }).sort({ name: 1 }).lean<ISavedView[]>();

  const tableRows: Row[] = rows.map((r) => ({
    _id: r._id as string,
    candidateCode: r.candidateCode as string,
    legalName: r.legalName as string,
    email: r.email as string,
    school: r.school,
    stage: r.stage as Row["stage"],
    authType: r.authType as Row["authType"],
    eadEnd: r.eadEnd,
    ownerName: r.ownerId ? names[r.ownerId as string] : undefined,
    nextDueDate: r.nextDueDate as string | null,
    riskFlags: r.riskFlags as string[],
  }));

  const keep = (over: Record<string, string>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) u.set(k, v);
    return `?${u}`;
  };
  const currentQuery = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]).toString();
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageHeader
        title="Candidates"
        description="Search, assign and manage CPT / OPT / STEM OPT candidate records."
        actions={
          <>
            {can(user, "candidates.export") && (
              <Button asChild variant="outline">
                <a href={`/api/candidates/export?${currentQuery}`}>
                  <Download className="h-4 w-4" /> Export CSV
                </a>
              </Button>
            )}
            {can(user, "candidates.export") &&
              (can(user, "sensitive.sevis.view") || can(user, "sensitive.ead.view") || can(user, "sensitive.dob.view")) && (
                <Button asChild variant="outline" title="Includes SEVIS ID, EAD number and date of birth you are permitted to see. Logged as a sensitive export.">
                  <a href={`/api/candidates/export?${currentQuery}${currentQuery ? "&" : ""}includeSensitive=1`}>
                    <Download className="h-4 w-4" /> Export incl. restricted
                  </a>
                </Button>
              )}
            {can(user, "candidates.import") && (
              <Button asChild variant="outline">
                <Link href="/candidates/import">
                  <Upload className="h-4 w-4" /> Import
                </Link>
              </Button>
            )}
            {can(user, "candidates.create") && (
              <Button asChild>
                <Link href="/candidates/new">
                  <Plus className="h-4 w-4" /> New candidate
                </Link>
              </Button>
            )}
          </>
        }
      />

      {views.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Bookmark className="h-4 w-4 text-muted-foreground" />
          {views.map((v) => (
            <span key={v._id} className="inline-flex items-center overflow-hidden rounded-full border bg-card text-xs">
              <Link href={`/candidates?${v.query}`} className="px-3 py-1 hover:bg-muted">
                {v.name}
              </Link>
              <form action={deleteViewAction}>
                <input type="hidden" name="id" value={v._id} />
                <button aria-label={`Delete view ${v.name}`} className="border-l px-1.5 py-1 hover:bg-muted">
                  <X className="h-3 w-3" />
                </button>
              </form>
            </span>
          ))}
        </div>
      )}

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 border-b p-4">
          <Input name="q" defaultValue={sp.q ?? ""} placeholder="Search name, email, code, school…" className="w-64" />
          <Select name="stage" defaultValue={sp.stage ?? ""} className="w-40">
            <option value="">All stages</option>
            {CANDIDATE_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </Select>
          {can(user, "immigration.view") && (
            <Select name="authType" defaultValue={sp.authType ?? ""} className="w-36">
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
          <Select name="ownerId" defaultValue={sp.ownerId ?? ""} className="w-44">
            <option value="">All owners</option>
            <option value="unassigned">Unassigned</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Input name="tag" defaultValue={sp.tag ?? ""} placeholder="Tag" className="w-28" />
          <Input name="dueBefore" type="date" defaultValue={sp.dueBefore ?? ""} className="w-40" title="Due on or before" />
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="risk" value="1" defaultChecked={sp.risk === "1"} /> At risk
          </label>
          <Select name="sort" defaultValue={sp.sort ?? "-created"} className="w-40">
            <option value="-created">Newest first</option>
            <option value="name">Name A–Z</option>
            <option value="-name">Name Z–A</option>
            <option value="due">Next due</option>
            <option value="code">Code</option>
          </Select>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          <Button asChild variant="ghost">
            <Link href="/candidates">Reset</Link>
          </Button>
        </form>

        <CandidateTable
          rows={tableRows}
          today={todayIn(user.timezone)}
          canBulk={can(user, "candidates.edit")}
          canAssign={can(user, "candidates.assign")}
          owners={owners}
          showImmigration={can(user, "immigration.view")}
        />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
          <span>
            {total.toLocaleString()} candidate{total === 1 ? "" : "s"} · page {page} of {pages}
          </span>
          <div className="flex items-center gap-2">
            <form action={saveViewAction} className="flex items-center gap-1.5">
              <input type="hidden" name="query" value={currentQuery} />
              <Input name="name" placeholder="Save this view as…" className="h-8 w-44 text-xs" required maxLength={60} />
              <Button type="submit" size="sm" variant="outline">
                Save view
              </Button>
            </form>
            {page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={keep({ page: String(page - 1) })}>Previous</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild variant="outline" size="sm">
                <Link href={keep({ page: String(page + 1) })}>Next</Link>
              </Button>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}
