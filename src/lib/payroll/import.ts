import { connectDb } from "@/lib/db/connect";
import { audit } from "@/lib/audit";
import { assertCan, candidateScopeFilter } from "@/lib/rbac/can";
import type { SessionUser } from "@/lib/auth/session";
import { Candidate, type ICandidate } from "@/lib/db/models/candidate";
import { PayrollItem, type IPayrollItem } from "@/lib/db/models/payroll-item";
import { computeItemFlags, parseRegisterCsv, type ExceptionFlag, type RegisterRow } from "./register-csv";
import { loadBatch, recomputeTotals, registerEdit, upsertItem } from "./batches";
import { linkEmergencyForCandidates } from "./emergency";
import { canEditBatch } from "./batch-rules";
import { PayrollError } from "./errors";
import { logSync } from "./sync-log";
import type { IPayrollBatch } from "@/lib/db/models/payroll-batch";

/**
 * Gusto payroll-register CSV import (manual route). Rows are matched to candidates ONLY through
 * `payrollMapping.employeeId`; unmatched rows are flagged for review and NEVER create candidates. Idempotent by
 * (batch, externalEmployeeRef): re-importing the same file updates rows, it never duplicates them.
 */
export type MatchState = "matched" | "unmatched" | "ambiguous";

export interface PreviewRow extends RegisterRow {
  match: MatchState;
  candidateId?: string;
  candidateName?: string;
  /** Already present in this batch (would be updated, not duplicated). */
  existing: boolean;
  excluded: boolean;
}

export interface ImportPreview {
  headerErrors: string[];
  ignoredColumns: string[];
  truncated: boolean;
  rows: PreviewRow[];
  counts: { total: number; importable: number; errors: number; matched: number; unmatched: number; ambiguous: number; existing: number };
  batchEditable: boolean;
}

async function matchRows(actor: SessionUser, batch: IPayrollBatch, rows: RegisterRow[]) {
  const refs = [...new Set(rows.map((r) => r.externalEmployeeRef).filter(Boolean))];
  const found = refs.length
    ? await Candidate.find({ "payrollMapping.employeeId": { $in: refs }, ...candidateScopeFilter(actor) })
        .select("legalName candidateCode payrollMapping")
        .lean<ICandidate[]>()
    : [];
  const byRef = new Map<string, ICandidate[]>();
  for (const c of found) {
    const m = c.payrollMapping;
    if (!m?.employeeId) continue;
    if (batch.companyRef && m.companyRef && m.companyRef !== batch.companyRef) continue; // different Gusto company
    byRef.set(m.employeeId, [...(byRef.get(m.employeeId) ?? []), c]);
  }
  return byRef;
}

export async function previewRegisterImport(actor: SessionUser, batchId: string, csv: string): Promise<ImportPreview> {
  assertCan(actor, "payroll.prepare");
  assertCan(actor, "payroll.amounts.view");
  await connectDb();
  const batch = await loadBatch(batchId);
  const parsed = parseRegisterCsv(csv);
  const byRef = await matchRows(actor, batch, parsed.rows);
  const existingItems = await PayrollItem.find({ batchId }).select("externalEmployeeRef status").lean<IPayrollItem[]>();
  const existing = new Map(existingItems.map((i) => [i.externalEmployeeRef, i.status]));

  const rows: PreviewRow[] = parsed.rows.map((r) => {
    const cands = byRef.get(r.externalEmployeeRef) ?? [];
    const match: MatchState = cands.length === 1 ? "matched" : cands.length > 1 ? "ambiguous" : "unmatched";
    const flags = [...new Set<ExceptionFlag>([...r.flags, ...(match !== "matched" ? (["unmatched_employee"] as ExceptionFlag[]) : [])])];
    return {
      ...r, flags, match,
      candidateId: match === "matched" ? cands[0]._id : undefined,
      candidateName: match === "matched" ? cands[0].legalName : undefined,
      existing: existing.has(r.externalEmployeeRef),
      excluded: existing.get(r.externalEmployeeRef) === "excluded",
    };
  });
  const importable = rows.filter((r) => r.errors.length === 0 && !r.excluded);
  return {
    headerErrors: parsed.headerErrors,
    ignoredColumns: parsed.ignoredColumns,
    truncated: parsed.truncated,
    rows,
    counts: {
      total: rows.length,
      importable: importable.length,
      errors: rows.filter((r) => r.errors.length).length,
      matched: rows.filter((r) => r.match === "matched").length,
      unmatched: rows.filter((r) => r.match === "unmatched").length,
      ambiguous: rows.filter((r) => r.match === "ambiguous").length,
      existing: rows.filter((r) => r.existing).length,
    },
    batchEditable: canEditBatch(batch.status),
  };
}

export async function commitRegisterImport(actor: SessionUser, batchId: string, csv: string) {
  assertCan(actor, "payroll.prepare");
  assertCan(actor, "payroll.amounts.view");
  const preview = await previewRegisterImport(actor, batchId, csv); // always re-validated server-side; never trust a client preview
  if (preview.headerErrors.length) {
    await logSync({ kind: "import", level: "error", message: `Register import rejected: ${preview.headerErrors.join(" ")}`, batchId, actorId: actor.id });
    throw new PayrollError(preview.headerErrors.join(" "), 422, "bad_header");
  }
  const batch = await registerEdit(actor, batchId, "Register CSV import");
  const counts = { created: 0, updated: 0, unmatched: 0, ambiguous: 0, skippedErrors: 0, skippedExcluded: 0 };
  const linked: string[] = [];

  for (const r of preview.rows) {
    if (r.errors.length) {
      counts.skippedErrors++;
      continue;
    }
    if (r.excluded) {
      counts.skippedExcluded++;
      continue;
    }
    const matched = r.match === "matched";
    if (r.match === "unmatched") counts.unmatched++;
    if (r.match === "ambiguous") counts.ambiguous++;
    const flags = computeItemFlags({ payType: r.payType, hours: r.hours, grossCents: r.grossCents, netCents: r.netCents, matched });
    const outcome = await upsertItem(
      batchId,
      r.externalEmployeeRef,
      {
        candidateId: matched ? r.candidateId : null,
        employeeName: r.employeeName,
        hours: r.hours, payType: r.payType, grossCents: r.grossCents, netCents: r.netCents,
        bonusesCents: r.bonusesCents, deductionsCents: r.deductionsCents, adjustmentsCents: r.adjustmentsCents,
        adjustmentNote: r.notes,
        exceptionFlags: flags,
        status: flags.length ? "flagged" : "ok",
        updatedBy: actor.id,
      },
      { kind: batch.kind, source: "csv_import", createdBy: actor.id },
    );
    counts[outcome]++;
    if (matched && r.candidateId) linked.push(r.candidateId);
  }
  await recomputeTotals(batchId);
  await logSync({
    kind: "import", batchId, actorId: actor.id, source: "ui", counts,
    level: counts.skippedErrors || counts.unmatched || counts.ambiguous ? "warn" : "info",
    message: `Register CSV import: ${counts.created} created, ${counts.updated} updated, ${counts.unmatched + counts.ambiguous} unmatched, ${counts.skippedErrors} rejected${preview.ignoredColumns.length ? `; ignored sensitive columns: ${preview.ignoredColumns.join(", ")}` : ""}`,
  });
  await audit({
    actor, action: "import", entityType: "payroll_batch", entityId: batchId,
    summary: `Imported payroll register CSV (${counts.created} created, ${counts.updated} updated, ${counts.unmatched + counts.ambiguous} unmatched, ${counts.skippedErrors} rejected; amounts not logged)`,
    after: { ...counts, ignoredColumns: preview.ignoredColumns },
  });
  await linkEmergencyForCandidates(batchId, [...new Set(linked)], { actor, source: "ui" });
  return { counts, ignoredColumns: preview.ignoredColumns };
}
