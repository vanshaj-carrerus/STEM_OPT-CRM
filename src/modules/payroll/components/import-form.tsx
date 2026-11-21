"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FormAlert, Label } from "@/components/ui/form";
import { Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import type { ImportPreview } from "@/lib/payroll/import";
import type { ActionResult } from "@/lib/payroll/errors";
import { formatCents } from "@/lib/payroll/money";
import { EXCEPTION_FLAG_LABELS, type ExceptionFlag } from "@/lib/payroll/register-csv";

/**
 * Gusto payroll-register CSV import: choose file → server-side preview with per-row validation → commit.
 * The file text is held in state and re-sent on commit; the server re-validates everything (the preview is never trusted).
 */
export function RegisterImport({
  batchId,
  preview,
  commit,
}: {
  batchId: string;
  preview: (batchId: string, csv: string) => Promise<{ error?: string; preview?: ImportPreview }>;
  commit: (batchId: string, csv: string) => Promise<ActionResult>;
}) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [data, setData] = useState<ImportPreview | null>(null);
  const [msg, setMsg] = useState<{ error?: string; message?: string }>({});
  const [pending, start] = useTransition();

  async function onFile(f: File | undefined) {
    setData(null);
    setMsg({});
    if (!f) return;
    if (f.size > 900_000) {
      setMsg({ error: "File is larger than ~900 KB. Split the export by pay group." });
      return;
    }
    const text = await f.text();
    setCsv(text);
    setFileName(f.name);
    start(async () => {
      const r = await preview(batchId, text);
      if (r.error) setMsg({ error: r.error });
      else setData(r.preview ?? null);
    });
  }

  function doCommit() {
    start(async () => {
      const r = await commit(batchId, csv);
      setMsg(r.error ? { error: r.error } : { message: r.message });
      if (!r.error) setData(null);
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="register-file">Gusto payroll register export (.csv)</Label>
        <input id="register-file" type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="block text-sm" />
        <p className="mt-1 text-xs text-muted-foreground">
          Rows are matched by the Gusto employee ID mapped on each candidate. Unmatched rows are flagged and never create candidates. Tax IDs, bank and
          address columns are ignored.
        </p>
      </div>
      <FormAlert error={msg.error} message={msg.message} />
      {pending && <p className="text-xs text-muted-foreground">Working…</p>}
      {data && (
        <div className="space-y-3">
          {data.headerErrors.length > 0 && <FormAlert error={data.headerErrors.join(" ")} />}
          {data.ignoredColumns.length > 0 && <p className="text-xs text-muted-foreground">Ignored sensitive columns: {data.ignoredColumns.join(", ")}</p>}
          {data.truncated && <p className="text-xs text-warning">Only the first 5,000 rows are shown/imported.</p>}
          {data.headerErrors.length === 0 && (
            <>
              <p className="text-sm">
                {fileName}: {data.counts.total} rows · <strong>{data.counts.importable}</strong> importable · {data.counts.matched} matched ·{" "}
                {data.counts.unmatched + data.counts.ambiguous} unmatched · {data.counts.errors} with errors · {data.counts.existing} already in this batch (updated, not duplicated)
              </p>
              <TableWrap className="max-h-96 overflow-y-auto rounded-md border">
                <Table>
                  <THead>
                    <tr>
                      <TH>#</TH>
                      <TH>Employee ID</TH>
                      <TH>Match</TH>
                      <TH>Hours</TH>
                      <TH>Gross</TH>
                      <TH>Net</TH>
                      <TH>Validation</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {data.rows.map((r) => (
                      <TR key={r.line}>
                        <TD>{r.line}</TD>
                        <TD>
                          {r.externalEmployeeRef || "—"}
                          {r.employeeName && <span className="block text-xs text-muted-foreground">{r.employeeName}</span>}
                        </TD>
                        <TD>
                          {r.match === "matched" ? <Badge tone="success">{r.candidateName}</Badge> : <Badge tone="danger">{r.match === "ambiguous" ? "Ambiguous" : "Unmatched"}</Badge>}
                          {r.existing && <Badge tone="info" className="ml-1">Update</Badge>}
                        </TD>
                        <TD>{r.hours ?? "—"}</TD>
                        <TD>{formatCents(r.grossCents)}</TD>
                        <TD>{formatCents(r.netCents)}</TD>
                        <TD className="text-xs">
                          {r.errors.map((e) => (
                            <span key={e} className="block text-danger">
                              {e}
                            </span>
                          ))}
                          {r.excluded && <span className="block text-muted-foreground">Excluded in batch — skipped</span>}
                          {r.flags
                            .filter((f) => f !== "unmatched_employee")
                            .map((f) => (
                              <span key={f} className="block text-warning">
                                {EXCEPTION_FLAG_LABELS[f as ExceptionFlag]}
                              </span>
                            ))}
                          {!r.errors.length && !r.flags.length && r.match === "matched" && <span className="text-success">OK</span>}
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
              {!data.batchEditable && <FormAlert error="This batch can no longer be edited, so nothing can be imported." />}
              <Button type="button" onClick={doCommit} disabled={pending || !data.batchEditable || data.counts.importable === 0}>
                Import {data.counts.importable} row{data.counts.importable === 1 ? "" : "s"}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
