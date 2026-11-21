import Link from "next/link";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";
import { listMappingOverview } from "@/lib/payroll/queries";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { ActionForm } from "../components/action-form";
import { clearMappingAction, mappingAction } from "@/app/(app)/payroll/actions";

type SP = Record<string, string | undefined>;

export async function MappingSection({ user, sp }: { user: SessionUser; sp: SP }) {
  const view = sp.view === "mapped" ? "mapped" : "unmapped";
  const { rows, total, unmappedTotal } = await listMappingOverview(user, { q: sp.q, view, page: Number(sp.page) || 1 });
  const canEdit = can(user, "payroll.prepare");
  return (
    <Card>
      <div className="border-b p-4 text-sm text-muted-foreground">
        A candidate is never assumed to be a payroll employee: map each one explicitly to their Gusto employee ID. <strong>{unmappedTotal}</strong> active candidate
        {unmappedTotal === 1 ? " is" : "s are"} not mapped.
      </div>
      <form method="get" className="flex flex-wrap items-end gap-3 border-b p-4">
        <input type="hidden" name="tab" value="mapping" />
        <Select name="view" defaultValue={view} className="w-40" aria-label="Mapping view">
          <option value="unmapped">Unmapped</option>
          <option value="mapped">Mapped</option>
        </Select>
        <Input name="q" defaultValue={sp.q ?? ""} placeholder="Search name or code…" className="w-64" />
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title={view === "unmapped" ? "No unmapped candidates" : "No mapped candidates"} />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <tr>
                <TH>Candidate</TH>
                <TH>Gusto employee ID</TH>
                <TH>Company</TH>
                {canEdit && <TH>{view === "unmapped" ? "Map to Gusto" : "Change / remove"}</TH>}
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => (
                <TR key={r._id}>
                  <TD>
                    <Link href={`/candidates/${r._id}?tab=payroll`} className="font-medium text-primary hover:underline">
                      {r.legalName}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{r.candidateCode}</span>
                  </TD>
                  <TD>{r.mapping?.employeeId ? r.mapping.employeeId : <Badge tone="warning">Not mapped</Badge>}</TD>
                  <TD>{r.mapping?.companyRef ?? "—"}</TD>
                  {canEdit && (
                    <TD>
                      <ActionForm action={mappingAction} submit={r.mapping ? "Update" : "Map"} size="sm" inline>
                        <input type="hidden" name="candidateId" value={r._id} />
                        <Input name="employeeId" defaultValue={r.mapping?.employeeId ?? ""} placeholder="Gusto employee ID" required className="w-48" aria-label="Gusto employee ID" />
                        <input type="hidden" name="companyRef" value={r.mapping?.companyRef ?? ""} />
                        <input type="hidden" name="payType" value={r.mapping?.payType ?? ""} />
                        <input type="hidden" name="paySchedule" value={r.mapping?.paySchedule ?? ""} />
                      </ActionForm>
                      {r.mapping && (
                        <ActionForm action={clearMappingAction} submit="Remove" variant="ghost" size="sm" inline className="mt-1">
                          <input type="hidden" name="candidateId" value={r._id} />
                          <Input name="reason" placeholder="Reason (required)" required minLength={5} className="w-48" aria-label="Reason for removing the mapping" />
                        </ActionForm>
                      )}
                    </TD>
                  )}
                </TR>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      <div className="border-t px-4 py-3 text-xs text-muted-foreground">Showing up to 50 of {total}. Use search to narrow the list.</div>
    </Card>
  );
}
