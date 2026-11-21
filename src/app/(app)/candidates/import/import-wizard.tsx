"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Download } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormAlert, Input, Select } from "@/components/ui/form";
import { EmptyState, Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { FIELD_BY_KEY, IMPORT_FIELDS } from "@/lib/import/fields";
import { ROW_STATUSES, ROW_STATUS_LABELS, type CommitSummary, type DuplicateHandling, type PreviewResponse, type RowStatus } from "@/lib/import/types";

const TONE: Record<RowStatus, Tone> = {
  valid: "success",
  invalid: "danger",
  duplicate_db: "warning",
  possible_duplicate_db: "warning",
  duplicate_file: "warning",
  possible_duplicate_file: "warning",
};

type Filter = "all" | "valid" | "invalid" | "duplicates";
const isDup = (s: RowStatus) => s.includes("duplicate");

async function readJson<T>(res: Response): Promise<T & { error?: string; details?: { message: string }[] }> {
  return (await res.json().catch(() => ({}))) as T & { error?: string; details?: { message: string }[] };
}

export function ImportWizard() {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [result, setResult] = useState<CommitSummary | null>(null);
  const [busy, setBusy] = useState<"upload" | "remap" | "commit" | null>(null);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [handling, setHandling] = useState<DuplicateHandling>("skip");
  const [confirmed, setConfirmed] = useState(false);

  const mappingChanged = useMemo(() => !!preview && preview.mapping.some((m, i) => (m ?? null) !== (mapping[i] ?? null)), [preview, mapping]);

  function accept(p: PreviewResponse) {
    setPreview(p);
    setMapping(p.mapping);
    setConfirmed(false);
  }

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    const fd = new FormData(e.currentTarget);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return setError("Choose a .csv or .xlsx file.");
    if (file.size > 5 * 1024 * 1024) return setError("The file is larger than the 5 MB limit.");
    setBusy("upload");
    try {
      const res = await fetch("/api/candidates/import", { method: "POST", body: fd, credentials: "same-origin" });
      const body = await readJson<PreviewResponse>(res);
      if (!res.ok) return setError(body.error ?? "The file could not be processed.");
      accept(body);
    } catch {
      setError("Network error — the file was not uploaded.");
    } finally {
      setBusy(null);
    }
  }

  async function applyMapping() {
    if (!preview) return;
    setError(undefined);
    setBusy("remap");
    try {
      const res = await fetch(`/api/candidates/import/${preview.jobId}/mapping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping }),
      });
      const body = await readJson<PreviewResponse>(res);
      if (!res.ok) return setError(body.error ?? "The mapping could not be applied.");
      accept(body);
    } catch {
      setError("Network error — the mapping was not applied.");
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!preview) return;
    setError(undefined);
    setBusy("commit");
    try {
      const res = await fetch(`/api/candidates/import/${preview.jobId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmMasterRoster: confirmed, duplicateHandling: handling }),
      });
      const body = await readJson<CommitSummary>(res);
      if (!res.ok) return setError(body.details?.[0]?.message ?? body.error ?? "The import failed.");
      setResult(body);
    } catch {
      setError("Network error — check the candidate list before retrying; a partial import may have occurred.");
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (preview) await fetch(`/api/candidates/import/${preview.jobId}`, { method: "DELETE" }).catch(() => undefined);
    setPreview(null);
    setMapping([]);
    setError(undefined);
  }

  /* ----------------------------- step 3: result ----------------------------- */
  if (result) {
    const notCreated = result.outcomes.filter((o) => o.status !== "created");
    return (
      <Card>
        <CardHeader title="Import finished" description="Row data used for this import has been wiped; only the outcome summary is kept." />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Badge tone="success">{result.created} created</Badge>
            <Badge tone="warning">{result.skipped} skipped</Badge>
            <Badge tone={result.failed ? "danger" : "neutral"}>{result.failed} failed</Badge>
          </div>
          {notCreated.length > 0 && (
            <TableWrap>
              <Table>
                <THead>
                  <tr>
                    <TH>Row</TH>
                    <TH>Outcome</TH>
                    <TH>Details</TH>
                  </tr>
                </THead>
                <tbody>
                  {notCreated.slice(0, 300).map((o) => (
                    <TR key={o.row}>
                      <TD>{o.row}</TD>
                      <TD>{o.status.replace(/_/g, " ")}</TD>
                      <TD className="text-muted-foreground">{o.message ?? "—"}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
          <Button asChild>
            <Link href="/candidates">View candidates</Link>
          </Button>
        </CardBody>
      </Card>
    );
  }

  /* ----------------------------- step 1: upload ----------------------------- */
  if (!preview) {
    return (
      <Card>
        <CardHeader
          title="1. Upload roster"
          description="CSV or XLSX, up to 5 MB and 5,000 rows. You will review the column mapping, invalid rows and duplicates before anything is created."
          action={
            <Button asChild variant="outline" size="sm">
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- file download from an API route, not a page */}
              <a href="/api/candidates/import/template">
                <Download className="h-3.5 w-3.5" /> CSV template
              </a>
            </Button>
          }
        />
        <CardBody>
          <form onSubmit={upload} className="space-y-4">
            <FormAlert error={error} />
            <Input name="file" type="file" required accept=".csv,.xlsx" className="h-auto max-w-md py-1.5" aria-label="Roster file" />
            <Button type="submit" disabled={busy === "upload"}>
              {busy === "upload" ? "Reading and checking…" : "Upload and preview"}
            </Button>
          </form>
        </CardBody>
      </Card>
    );
  }

  /* ------------------------- step 2: mapping + preview ------------------------- */
  const used = new Set(mapping.filter(Boolean) as string[]);
  const visible = preview.rows.filter((r) =>
    filter === "all" ? true : filter === "valid" ? r.status === "valid" : filter === "invalid" ? r.status === "invalid" : isDup(r.status),
  );
  const s = preview.summary;
  const dupTotal = s.duplicate_db + s.possible_duplicate_db + s.duplicate_file + s.possible_duplicate_file;
  const softTotal = s.possible_duplicate_db + s.possible_duplicate_file;
  const willImport = s.valid + (handling === "import_soft" ? softTotal : 0);
  const blocked = mappingChanged || preview.missingRequired.length > 0 || willImport === 0;

  return (
    <div className="space-y-5">
      <FormAlert error={error} />

      <Card>
        <CardHeader
          title="2. Check column mapping"
          description={`${preview.filename} — ${preview.totalRows.toLocaleString()} rows. Columns were matched automatically; adjust anything that is wrong.`}
          action={
            <Button type="button" variant="ghost" size="sm" onClick={cancel}>
              Start over
            </Button>
          }
        />
        <CardBody className="space-y-3">
          {preview.missingRequired.length > 0 && (
            <FormAlert error={`Map these required columns before importing: ${preview.missingRequired.join(", ")}.`} />
          )}
          {preview.ignoredFields.length > 0 && (
            <p className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning">
              Your role cannot store these mapped fields, so they will be ignored: {preview.ignoredFields.join(", ")}.
            </p>
          )}
          {preview.neutralizedCells > 0 && (
            <p className="text-xs text-muted-foreground">
              {preview.neutralizedCells} cell(s) started with a spreadsheet formula character (= + - @); that character was removed for safety.
            </p>
          )}
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>Column in file</TH>
                  <TH>First row</TH>
                  <TH>Import as</TH>
                </tr>
              </THead>
              <tbody>
                {preview.headers.map((h, i) => (
                  <TR key={`${h}-${i}`}>
                    <TD className="font-medium">{h}</TD>
                    <TD className="max-w-48 truncate text-muted-foreground">{preview.sample[i] || "—"}</TD>
                    <TD>
                      <Select
                        value={mapping[i] ?? ""}
                        onChange={(e) => setMapping((m) => m.map((v, j) => (j === i ? e.target.value || null : v)))}
                        className="w-56"
                        aria-label={`Import ${h} as`}
                      >
                        <option value="">— Not imported —</option>
                        {IMPORT_FIELDS.map((f) => (
                          <option key={f.key} value={f.key} disabled={used.has(f.key) && mapping[i] !== f.key}>
                            {f.label}
                            {f.sensitive ? " (protected)" : ""}
                          </option>
                        ))}
                      </Select>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <div className="flex items-center gap-3">
            <Button type="button" variant="secondary" onClick={applyMapping} disabled={!mappingChanged || busy === "remap"}>
              {busy === "remap" ? "Re-checking…" : "Apply mapping and re-check"}
            </Button>
            {mappingChanged && <span className="text-xs text-warning">Mapping changed — re-check before importing.</span>}
            <span className="text-xs text-muted-foreground">
              {preview.mapping.filter((m) => !m).length} unmapped column(s) will not be imported.
            </span>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="3. Review rows" description="Every row was validated and compared with existing candidates and with other rows in the file." />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge tone="success">{s.valid} valid</Badge>
            <Badge tone={s.invalid ? "danger" : "neutral"}>{s.invalid} invalid</Badge>
            <Badge tone={dupTotal ? "warning" : "neutral"}>{dupTotal} duplicate / possible duplicate</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["all", "valid", "invalid", "duplicates"] as Filter[]).map((f) => (
              <Button key={f} type="button" size="sm" variant={filter === f ? "secondary" : "outline"} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "valid" ? "Valid" : f === "invalid" ? "Invalid" : "Duplicates"}
              </Button>
            ))}
          </div>
          {preview.truncated && (
            <p className="text-xs text-muted-foreground">
              Showing rows that need attention plus a sample of valid rows. All {preview.totalRows.toLocaleString()} rows were checked and will be handled the same way.
            </p>
          )}
          {visible.length === 0 ? (
            <EmptyState title="No rows in this view" />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <tr>
                    <TH>Row</TH>
                    <TH>Status</TH>
                    <TH>Name</TH>
                    <TH>Email</TH>
                    <TH>Details</TH>
                  </tr>
                </THead>
                <tbody>
                  {visible.map((r) => (
                    <TR key={r.rowNumber}>
                      <TD>{r.rowNumber}</TD>
                      <TD>
                        <Badge tone={TONE[r.status]}>{ROW_STATUS_LABELS[r.status]}</Badge>
                      </TD>
                      <TD>{r.cells.legalName ?? "—"}</TD>
                      <TD>{r.cells.email ?? "—"}</TD>
                      <TD className="text-xs text-muted-foreground">
                        {Object.entries(r.errors).map(([k, msg]) => (
                          <p key={k} className="text-danger">
                            {FIELD_BY_KEY[k]?.label ?? (k === "row" ? "Row" : k)}: {msg}
                          </p>
                        ))}
                        {r.message && <p>{r.message}</p>}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="4. Confirm and import" />
        <CardBody className="space-y-4">
          <div role="alert" className="flex gap-3 rounded-md border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Import real candidate data only after the department&apos;s approved master roster has been validated. Do not import test, placeholder or
              unverified lists into this system.
            </p>
          </div>
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Duplicates</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="dup" checked={handling === "skip"} onChange={() => setHandling("skip")} className="mt-1" />
              <span>Skip duplicates and possible duplicates (recommended)</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="dup" checked={handling === "import_soft"} onChange={() => setHandling("import_soft")} className="mt-1" />
              <span>
                Also import possible duplicates (same name and date of birth, different email). Same email or SEVIS ID is never imported twice.
              </span>
            </label>
          </fieldset>
          <label className="flex items-start gap-2 text-sm font-medium">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
            <span>I confirm this is the approved master roster.</span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={commit} disabled={!confirmed || blocked || busy === "commit"}>
              {busy === "commit" ? "Importing…" : `Import ${willImport.toLocaleString()} candidate${willImport === 1 ? "" : "s"}`}
            </Button>
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            {blocked && <span className="text-xs text-muted-foreground">Resolve the mapping above and make sure at least one row can be imported.</span>}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
