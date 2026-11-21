import Papa from "papaparse";
import { parseMoneyToCents } from "./money";

/**
 * Parser + validator for a Gusto payroll-register CSV export (pure — no DB, no network).
 * Matching rows to candidates happens in the import service (via Candidate.payrollMapping.employeeId).
 * Sensitive columns (tax IDs, bank/routing numbers, DOB, address) are NEVER read — they are reported as ignored.
 */
export const PAY_TYPES = ["hourly", "salary", "stipend", "other"] as const;
export type PayType = (typeof PAY_TYPES)[number];

export const MAX_REGISTER_ROWS = 5000;
export const MAX_REGISTER_CHARS = 900_000; // stays under the default 1 MB server-action body limit

export const EXCEPTION_FLAGS = [
  "unmatched_employee",
  "missing_hours",
  "high_hours",
  "negative_net",
  "net_exceeds_gross",
  "missing_amounts",
] as const;
export type ExceptionFlag = (typeof EXCEPTION_FLAGS)[number];

export const EXCEPTION_FLAG_LABELS: Record<ExceptionFlag, string> = {
  unmatched_employee: "Employee not mapped to a candidate",
  missing_hours: "Hourly pay without hours",
  high_hours: "Unusually high hours",
  negative_net: "Negative net pay",
  net_exceeds_gross: "Net pay exceeds gross pay",
  missing_amounts: "No gross or net amount",
};

/** Flags that block final approval until the row is fixed or excluded. */
export const BLOCKING_FLAGS: ExceptionFlag[] = ["unmatched_employee"];

export const HIGH_HOURS_THRESHOLD = 200; // per pay period

export interface RegisterRow {
  line: number; // 1-based data row number (header excluded)
  externalEmployeeRef: string;
  employeeName?: string;
  hours: number | null;
  payType: PayType;
  grossCents: number | null;
  netCents: number | null;
  bonusesCents: number;
  deductionsCents: number;
  adjustmentsCents: number;
  notes?: string;
  errors: string[]; // row cannot be imported
  flags: ExceptionFlag[]; // importable but flagged for review
}

export interface RegisterParse {
  rows: RegisterRow[];
  ignoredColumns: string[];
  headerErrors: string[];
  truncated: boolean;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

const ALIASES = {
  ref: ["employeeid", "employeeuuid", "employeeref", "gustoemployeeid", "externalemployeeid", "employeenumber", "empid"],
  name: ["employeename", "name", "fullname", "employee"],
  first: ["firstname"],
  last: ["lastname"],
  hours: ["hours", "totalhours"],
  regularHours: ["regularhours", "reghours"],
  overtimeHours: ["overtimehours", "othours", "overtime"],
  payType: ["paytype", "compensationtype", "paymenttype", "paymentunit", "flsastatus"],
  gross: ["grosspay", "gross", "grosswages", "totalgross", "grossearnings"],
  net: ["netpay", "net", "netwages", "netearnings"],
  bonuses: ["bonus", "bonuses", "bonuspay"],
  deductions: ["deductions", "totaldeductions", "employeedeductions"],
  adjustments: ["adjustments", "adjustment", "reimbursements", "reimbursement"],
  notes: ["notes", "note", "memo", "comment", "comments"],
} as const;

/** Columns that carry data we must never ingest. */
const SENSITIVE = /^(ssn|ein|tin|itin)$|social|taxid|taxidentifier|routing|accountnumber|bankaccount|bankacct|dob|dateofbirth|birth|homeaddress|street/;

const SSN_LIKE = /^\d{3}-?\d{2}-?\d{4}$/;
const REF_OK = /^[A-Za-z0-9._-]{1,64}$/;

function findCol(headers: string[], aliases: readonly string[]): string | null {
  for (const a of aliases) {
    const h = headers.find((x) => norm(x) === a);
    if (h) return h;
  }
  return null;
}

export function normalizePayType(v: string | undefined | null): PayType {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return "hourly";
  if (s.startsWith("hour")) return "hourly";
  if (s.startsWith("sal") || s === "fixed" || s === "exempt") return "salary";
  if (s.startsWith("stip")) return "stipend";
  return "other";
}

/** Rules that raise an exception flag on a row/item (shared with manual item entry). */
export function computeItemFlags(i: {
  payType: PayType;
  hours: number | null;
  grossCents: number | null;
  netCents: number | null;
  matched: boolean;
}): ExceptionFlag[] {
  const flags: ExceptionFlag[] = [];
  if (!i.matched) flags.push("unmatched_employee");
  if (i.payType === "hourly" && (i.hours === null || i.hours <= 0)) flags.push("missing_hours");
  if (i.hours !== null && i.hours > HIGH_HOURS_THRESHOLD) flags.push("high_hours");
  if (i.grossCents === null && i.netCents === null) flags.push("missing_amounts");
  if (i.netCents !== null && i.netCents < 0) flags.push("negative_net");
  if (i.grossCents !== null && i.netCents !== null && i.netCents > i.grossCents) flags.push("net_exceeds_gross");
  return flags;
}

function parseHours(v: string | undefined): { value: number | null; error?: string } {
  const s = (v ?? "").trim();
  if (!s) return { value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { value: null, error: `Invalid hours "${s}"` };
  const n = Number(s);
  if (n > 744) return { value: null, error: "Hours exceed any possible pay period" };
  return { value: n };
}

export function parseRegisterCsv(text: string): RegisterParse {
  const empty: RegisterParse = { rows: [], ignoredColumns: [], headerErrors: [], truncated: false };
  if (!text || !text.trim()) return { ...empty, headerErrors: ["The file is empty."] };
  if (text.length > MAX_REGISTER_CHARS) return { ...empty, headerErrors: ["The file is too large (limit ~900 KB). Split it by pay group."] };

  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy" });
  const headers = (parsed.meta.fields ?? []).map((h) => h.trim());
  const headerErrors: string[] = [];

  const ignoredColumns = headers.filter((h) => SENSITIVE.test(norm(h)));
  const usable = headers.filter((h) => !ignoredColumns.includes(h));

  const refCol = findCol(usable, ALIASES.ref);
  const nameCol = findCol(usable, ALIASES.name);
  const firstCol = findCol(usable, ALIASES.first);
  const lastCol = findCol(usable, ALIASES.last);
  const hoursCol = findCol(usable, ALIASES.hours);
  const regCol = findCol(usable, ALIASES.regularHours);
  const otCol = findCol(usable, ALIASES.overtimeHours);
  const typeCol = findCol(usable, ALIASES.payType);
  const grossCol = findCol(usable, ALIASES.gross);
  const netCol = findCol(usable, ALIASES.net);
  const bonusCol = findCol(usable, ALIASES.bonuses);
  const dedCol = findCol(usable, ALIASES.deductions);
  const adjCol = findCol(usable, ALIASES.adjustments);
  const notesCol = findCol(usable, ALIASES.notes);

  if (!refCol) headerErrors.push("Missing an employee ID column (e.g. \"Employee ID\"). Rows are matched by the Gusto employee ID mapped on the candidate.");
  if (!grossCol && !netCol) headerErrors.push("Missing a gross or net pay column.");
  if (headerErrors.length) return { rows: [], ignoredColumns, headerErrors, truncated: false };

  const data = parsed.data.slice(0, MAX_REGISTER_ROWS);
  const seen = new Set<string>();
  const rows: RegisterRow[] = [];

  data.forEach((rec, idx) => {
    const get = (c: string | null) => (c ? (rec[c] ?? "").toString().trim() : "");
    const errors: string[] = [];
    const ref = get(refCol);
    if (!ref) errors.push("Employee ID is required.");
    else if (SSN_LIKE.test(ref)) errors.push("Employee ID looks like a tax identifier and was rejected — use the Gusto employee ID.");
    else if (!REF_OK.test(ref)) errors.push("Employee ID contains unsupported characters.");
    else if (seen.has(ref)) errors.push("Duplicate employee ID in this file.");
    if (ref) seen.add(ref);

    let hours: number | null = null;
    if (hoursCol) {
      const h = parseHours(get(hoursCol));
      hours = h.value;
      if (h.error) errors.push(h.error);
    } else if (regCol || otCol) {
      const r = parseHours(get(regCol));
      const o = parseHours(get(otCol));
      if (r.error) errors.push(r.error);
      if (o.error) errors.push(o.error);
      hours = r.value === null && o.value === null ? null : (r.value ?? 0) + (o.value ?? 0);
    }

    const money = (col: string | null, label: string): number | null => {
      const raw = get(col);
      if (!raw) return null;
      const c = parseMoneyToCents(raw);
      if (c === null) errors.push(`Invalid ${label} amount "${raw}".`);
      return c;
    };
    const grossCents = money(grossCol, "gross pay");
    const netCents = money(netCol, "net pay");
    const bonusesCents = money(bonusCol, "bonus") ?? 0;
    const deductionsCents = money(dedCol, "deduction") ?? 0;
    const adjustmentsCents = money(adjCol, "adjustment") ?? 0;

    const name = nameCol ? get(nameCol) : [get(firstCol), get(lastCol)].filter(Boolean).join(" ");
    const payType = normalizePayType(get(typeCol));
    // `matched` is decided by the import service; the parser only raises data-quality flags here.
    const flags = computeItemFlags({ payType, hours, grossCents, netCents, matched: true });

    rows.push({
      line: idx + 1,
      externalEmployeeRef: ref,
      employeeName: name || undefined,
      hours,
      payType,
      grossCents,
      netCents,
      bonusesCents,
      deductionsCents,
      adjustmentsCents,
      notes: get(notesCol).slice(0, 500) || undefined,
      errors,
      flags,
    });
  });

  return { rows, ignoredColumns, headerErrors, truncated: parsed.data.length > MAX_REGISTER_ROWS };
}

/* -------------------- settlement / provider-report amounts CSV -------------------- */

export interface AmountCsvResult {
  totalCents: number;
  count: number;
  references: string[];
  errors: string[];
}

/**
 * Sum an "amount" column of a bank-settlement or provider-report CSV (columns: amount [+ reference]).
 * Used to pre-fill reconciliation totals from a manual CSV upload — the human still confirms the numbers.
 */
export function parseAmountCsv(text: string): AmountCsvResult {
  const out: AmountCsvResult = { totalCents: 0, count: 0, references: [], errors: [] };
  if (!text.trim()) return { ...out, errors: ["The file is empty."] };
  if (text.length > MAX_REGISTER_CHARS) return { ...out, errors: ["The file is too large."] };
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy" });
  const headers = (parsed.meta.fields ?? []).map((h) => h.trim());
  const amountCol = findCol(headers, ["amount", "netamount", "total", "settlementamount", "debit", "netpay", "totalnetpay"]);
  const refCol = findCol(headers, ["reference", "settlementreference", "traceid", "transactionid", "id"]);
  if (!amountCol) return { ...out, errors: ["Missing an amount column."] };
  parsed.data.slice(0, MAX_REGISTER_ROWS).forEach((rec, i) => {
    const c = parseMoneyToCents(rec[amountCol]);
    if (c === null) {
      out.errors.push(`Row ${i + 1}: invalid amount "${rec[amountCol] ?? ""}".`);
      return;
    }
    out.totalCents += c;
    out.count++;
    const ref = refCol ? (rec[refCol] ?? "").trim() : "";
    if (ref && out.references.length < 5) out.references.push(ref.slice(0, 64));
  });
  return out;
}
