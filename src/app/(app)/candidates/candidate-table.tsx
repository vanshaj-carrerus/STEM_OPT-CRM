"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select, Input, FormAlert, SubmitButton } from "@/components/ui/form";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { bulkAction } from "./actions";
import { AUTH_TYPE_LABELS, CANDIDATE_STAGES, STAGE_LABELS } from "@/lib/candidates/constants";
import { formatDate, diffDays } from "@/lib/compliance/dates";

export interface Row {
  _id: string;
  candidateCode: string;
  legalName: string;
  email: string;
  school?: string;
  stage: keyof typeof STAGE_LABELS;
  authType?: keyof typeof AUTH_TYPE_LABELS;
  eadEnd?: string;
  ownerName?: string;
  nextDueDate?: string | null;
  riskFlags?: string[];
  clearedToWork?: boolean;
}

const stageTone: Record<string, Tone> = { new: "info", onboarding: "primary", active: "success", on_hold: "warning", offboarded: "neutral", archived: "neutral" };

function DueCell({ date, today }: { date?: string | null; today: string }) {
  if (!date) return <span className="text-muted-foreground">—</span>;
  const d = diffDays(date, today);
  const tone: Tone = d < 0 ? "danger" : d <= 7 ? "warning" : "neutral";
  return (
    <span className="inline-flex items-center gap-1.5">
      {formatDate(date)}
      {d < 0 ? <Badge tone={tone}>{Math.abs(d)}d overdue</Badge> : d <= 7 ? <Badge tone={tone}>in {d}d</Badge> : null}
    </span>
  );
}

export function CandidateTable({
  rows,
  today,
  canBulk,
  canAssign,
  owners,
  showImmigration,
}: {
  rows: Row[];
  today: string;
  canBulk: boolean;
  canAssign: boolean;
  owners: { id: string; name: string }[];
  showImmigration: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, action] = useActionState(bulkAction, {} as { message?: string; error?: string });
  const [op, setOp] = useState("stage");
  const all = rows.length > 0 && selected.size === rows.length;

  if (rows.length === 0) {
    return <EmptyState title="No candidates found" description="Adjust filters, or add a candidate / import the approved master roster." />;
  }

  return (
    <div>
      {canBulk && selected.size > 0 && (
        <form action={action} className="flex flex-wrap items-center gap-2 border-b bg-secondary/50 px-4 py-2.5">
          {[...selected].map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Select name="op" value={op} onChange={(e) => setOp(e.target.value)} className="w-40">
            <option value="stage">Change stage</option>
            {canAssign && <option value="assign">Assign owner</option>}
            <option value="tag">Add tag</option>
          </Select>
          {op === "stage" && (
            <Select name="value" className="w-44" defaultValue="active">
              {CANDIDATE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
          {op === "assign" && (
            <Select name="value" className="w-52" defaultValue="">
              <option value="">Unassigned</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
          {op === "tag" && <Input name="value" placeholder="Tag" className="w-44" />}
          <SubmitButton size="sm" pendingText="Applying…">
            Apply
          </SubmitButton>
          <div className="basis-full">
            <FormAlert error={state.error} message={state.message} />
          </div>
        </form>
      )}
      <TableWrap>
        <Table>
          <THead>
            <tr>
              {canBulk && (
                <TH className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={all}
                    onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r._id)))}
                  />
                </TH>
              )}
              <TH>Candidate</TH>
              <TH>Stage</TH>
              {showImmigration && <TH>Authorization</TH>}
              <TH>Owner</TH>
              <TH>Next due</TH>
              <TH>Risk</TH>
            </tr>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r._id}>
                {canBulk && (
                  <TD>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.legalName}`}
                      checked={selected.has(r._id)}
                      onChange={() => {
                        const n = new Set(selected);
                        if (n.has(r._id)) n.delete(r._id);
                        else n.add(r._id);
                        setSelected(n);
                      }}
                    />
                  </TD>
                )}
                <TD>
                  <Link href={`/candidates/${r._id}`} className="font-medium text-primary hover:underline">
                    {r.legalName}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {r.candidateCode} · {r.email}
                  </div>
                </TD>
                <TD>
                  <Badge tone={stageTone[r.stage] ?? "neutral"}>{STAGE_LABELS[r.stage]}</Badge>
                </TD>
                {showImmigration && (
                  <TD>
                    {r.authType && r.authType !== "none" ? (
                      <div>
                        <Badge tone="primary">{AUTH_TYPE_LABELS[r.authType]}</Badge>
                        {r.eadEnd && <div className="mt-0.5 text-xs text-muted-foreground">ends {formatDate(r.eadEnd)}</div>}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TD>
                )}
                <TD className="text-muted-foreground">{r.ownerName ?? <span className="italic">Unassigned</span>}</TD>
                <TD>
                  <DueCell date={r.nextDueDate} today={today} />
                </TD>
                <TD>
                  {r.riskFlags && r.riskFlags.length > 0 ? (
                    <Badge tone="danger">
                      <AlertTriangle className="h-3 w-3" /> {r.riskFlags.length}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </TableWrap>
    </div>
  );
}

export { Card };
