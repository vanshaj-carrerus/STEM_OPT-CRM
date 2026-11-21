import Papa from "papaparse";
import { cleanCell } from "./sanitize";

export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_COLUMNS = 100;

export class ImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportParseError";
  }
}

export interface ParsedSheet {
  headers: string[];
  /** One array of cleaned strings per data row, aligned with `headers`. Fully blank rows are dropped. */
  rows: string[][];
  /** Number of cells that had a leading formula character removed. */
  neutralizedCells: number;
}

/** Unique, non-empty header names ("Name", "Name (2)", "Column 3"). */
export function uniqueHeaders(raw: readonly unknown[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let base = cleanCell(h).value.slice(0, 80) || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    if (n > 1) base = `${base} (${n})`;
    return base;
  });
}

/** Shared tail of both parsers: header/limit checks, cell cleaning, blank-row removal. */
function finish(table: unknown[][]): ParsedSheet {
  const [headerRow, ...body] = table;
  if (!headerRow || headerRow.every((h) => cleanCell(h).value === "")) throw new ImportParseError("The file has no header row.");
  let width = headerRow.length;
  while (width > 0 && cleanCell(headerRow[width - 1]).value === "") width--; // trailing empty header cells
  if (width > IMPORT_MAX_COLUMNS) throw new ImportParseError(`The file has more than ${IMPORT_MAX_COLUMNS} columns.`);
  const headers = uniqueHeaders(headerRow.slice(0, width));

  let neutralizedCells = 0;
  const rows: string[][] = [];
  for (const r of body) {
    const cells = headers.map((_, i) => {
      const c = cleanCell(r[i]);
      if (c.neutralized) neutralizedCells++;
      return c.value;
    });
    if (cells.every((c) => c === "")) continue;
    rows.push(cells);
    if (rows.length > IMPORT_MAX_ROWS) throw new ImportParseError(`The file has more than ${IMPORT_MAX_ROWS.toLocaleString()} rows. Split it into smaller files.`);
  }
  if (rows.length === 0) throw new ImportParseError("The file has a header row but no data rows.");
  return { headers, rows, neutralizedCells };
}

export function parseCsv(text: string): ParsedSheet {
  const clean = text.replace(/^﻿/, "");
  const res = Papa.parse<string[]>(clean, { header: false, skipEmptyLines: false, dynamicTyping: false });
  const fatal = res.errors.find((e) => e.type === "Quotes");
  if (fatal) throw new ImportParseError(`The CSV could not be read (${fatal.message}, row ${(fatal.row ?? 0) + 1}).`);
  return finish(res.data);
}

/** ExcelJS cell values can be rich objects; only ever take the displayed value — never a formula. */
export function excelCellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10); // date-only (UTC)
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return excelCellToString(o.result); // formula → cached result
    if (Array.isArray(o.richText)) return o.richText.map((t) => String((t as { text?: string }).text ?? "")).join("");
    if ("text" in o) return String(o.text ?? "");
    if ("error" in o) return "";
    return "";
  }
  return String(v);
}

export async function parseXlsx(buffer: Buffer): Promise<ParsedSheet> {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new ImportParseError("The Excel file could not be read. Make sure it is a valid .xlsx file.");
  }
  const ws = wb.worksheets.find((w) => w.rowCount > 0);
  if (!ws) throw new ImportParseError("The workbook has no data.");
  const table: unknown[][] = [];
  const limit = IMPORT_MAX_ROWS + 50; // slack for blank rows; finish() enforces the real limit
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n > limit + 1) return;
    const cells: unknown[] = [];
    const count = Math.min(row.cellCount, IMPORT_MAX_COLUMNS + 5);
    for (let c = 1; c <= count; c++) cells.push(excelCellToString(row.getCell(c).value));
    table.push(cells);
  });
  return finish(table);
}

/** Dispatch on extension + magic bytes (an .xlsx is a zip: "PK"). Only .csv and .xlsx are accepted. */
export async function parseRosterFile(fileName: string, data: Buffer): Promise<ParsedSheet> {
  if (data.length === 0) throw new ImportParseError("The file is empty.");
  if (data.length > IMPORT_MAX_BYTES) throw new ImportParseError("The file is larger than the 5 MB limit.");
  const ext = fileName.split(".").pop()?.toLowerCase();
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  if (ext === "xlsx") {
    if (!isZip) throw new ImportParseError("This file is not a valid .xlsx workbook.");
    return parseXlsx(data);
  }
  if (ext === "csv" || ext === "txt") {
    if (isZip) throw new ImportParseError("This file looks like an Excel workbook; rename it to .xlsx.");
    return parseCsv(data.toString("utf8"));
  }
  throw new ImportParseError("Unsupported file type. Upload a .csv or .xlsx file.");
}
