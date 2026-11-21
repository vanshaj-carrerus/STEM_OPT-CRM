import { Badge, type Tone } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { diffDays, formatDate } from "@/lib/compliance/dates";
import type { MilestoneView } from "@/lib/immigration/overview";

const STATUS_TONE: Record<string, Tone> = {
  open: "info", in_progress: "primary", waiting_candidate: "warning", waiting_employer: "warning", waiting_dso: "warning",
  completed: "success", waived: "neutral", cancelled: "neutral",
};

/** Milestones and change-review tasks for this candidate. Tasks are managed in the Tasks tab; this is the read-only schedule. */
export function MilestonesCard({ milestones, today }: { milestones: MilestoneView[]; today: string }) {
  return (
    <Card>
      <CardHeader
        title="Milestones & reviews"
        description="Internal reminders generated from verified dates, plus change-review tasks. They do not replace official DSO reporting windows."
      />
      {milestones.length === 0 ? (
        <EmptyState title="No milestones yet" description="Milestones appear once an authorization period is verified against verified evidence." />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <tr>
                <TH>Milestone</TH>
                <TH>Due</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <tbody>
              {milestones.map((m) => {
                const open = !["completed", "waived", "cancelled"].includes(m.status);
                const d = diffDays(m.dueDate, today);
                return (
                  <TR key={m.id}>
                    <TD>
                      {m.title}
                      {m.kind === "change_review" && <Badge tone="warning" className="ml-2">change review</Badge>}
                    </TD>
                    <TD className="whitespace-nowrap">
                      {formatDate(m.dueDate)}
                      {open && d < 0 && <Badge tone="danger" className="ml-2">{Math.abs(d)}d overdue</Badge>}
                      {open && d >= 0 && d <= 7 && <Badge tone="warning" className="ml-2">in {d}d</Badge>}
                    </TD>
                    <TD>
                      <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status.replace("_", " ")}</Badge>
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}
