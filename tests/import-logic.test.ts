import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { normalizeDate, excelSerialToDate } from "@/lib/import/dates";
import { cleanCell } from "@/lib/import/sanitize";
import { TEMPLATE_HEADERS, guessMapping, missingRequiredFields, normalizeHeader, sanitizeMapping } from "@/lib/import/fields";
import { ImportParseError, parseCsv, parseRosterFile, parseXlsx } from "@/lib/import/parse";
import {
  classifyRow,
  detectInFileDuplicates,
  ignoredFields,
  parseAuthType,
  planCommit,
  validateRow,
  type ActorCaps,
} from "@/lib/import/rows";

const ALL: ActorCaps = { sevis: true, ead: true, dob: true, immigrationEdit: true };

describe("date normalization", () => {
  it("handles ISO, US M/D/YYYY, two-digit years and text months", () => {
    expect(normalizeDate("2026-03-05").value).toBe("2026-03-05");
    expect(normalizeDate("3/5/2026").value).toBe("2026-03-05");
    expect(normalizeDate("03-05-2026").value).toBe("2026-03-05");
    expect(normalizeDate("3/5/26").value).toBe("2026-03-05");
    expect(normalizeDate("3/5/99").value).toBe("1999-03-05");
    expect(normalizeDate("2026/3/5").value).toBe("2026-03-05");
    expect(normalizeDate("20260305").value).toBe("2026-03-05");
    expect(normalizeDate("Mar 5, 2026").value).toBe("2026-03-05");
    expect(normalizeDate("5 March 2026").value).toBe("2026-03-05");
    expect(normalizeDate("2026-03-05T00:00:00.000Z").value).toBe("2026-03-05");
  });
  it("reads clearly day-first dates and rejects impossible ones", () => {
    expect(normalizeDate("25/12/2025").value).toBe("2025-12-25");
    expect(normalizeDate("2/30/2026").error).toBeTruthy();
    expect(normalizeDate("13/13/2026").error).toBeTruthy();
    expect(normalizeDate("not a date").error).toBeTruthy();
  });
  it("converts Excel serials and Date objects without timezone shifts", () => {
    const serial = Date.UTC(2026, 2, 5) / 86_400_000 + 25569;
    expect(excelSerialToDate(serial).value).toBe("2026-03-05");
    expect(normalizeDate(String(serial)).value).toBe("2026-03-05");
    expect(normalizeDate(serial).value).toBe("2026-03-05");
    expect(normalizeDate(new Date(Date.UTC(2026, 2, 5))).value).toBe("2026-03-05");
    expect(normalizeDate(12).error).toBeTruthy(); // too small to be a plausible serial
  });
  it("treats blanks as no value", () => {
    expect(normalizeDate("")).toEqual({});
    expect(normalizeDate("   ")).toEqual({});
    expect(normalizeDate(null)).toEqual({});
  });
});

describe("formula-injection-safe cell cleaning", () => {
  it("strips leading formula characters from text", () => {
    expect(cleanCell("=HYPERLINK(\"http://x\")")).toMatchObject({ neutralized: true });
    expect(cleanCell("=1+1").value).toBe("1+1");
    expect(cleanCell("@SUM(A1)").value).toBe("SUM(A1)");
    expect(cleanCell("-cmd|' /C calc'!A0").value).toBe("cmd|' /C calc'!A0");
  });
  it("keeps phone-like and plain values, trims and drops control characters", () => {
    expect(cleanCell("+1 (555) 010-2000")).toEqual({ value: "+1 (555) 010-2000", neutralized: false });
    expect(cleanCell("  Ada\u0000 Lovelace \n")).toEqual({ value: "Ada Lovelace", neutralized: false });
  });
});

describe("header auto-mapping", () => {
  it("recognises common roster headers regardless of case and punctuation", () => {
    const m = guessMapping(["Full Name", "E-mail Address", "DOB", "SEVIS #", "Mobile", "University", "OPT Start Date", "EAD Expiry", "Favourite colour"]);
    expect(m).toEqual(["legalName", "email", "dateOfBirth", "sevisId", "phone", "school", "eadStart", "eadEnd", null]);
    expect(guessMapping(["SEVIS ID", "SEVIS Number"])).toEqual(["sevisId", null]); // each field maps once
  });
  it("maps first/last name and the template's own headers", () => {
    expect(guessMapping(["First Name", "Last Name", "Email"])).toEqual(["firstName", "lastName", "email"]);
    const m = guessMapping(TEMPLATE_HEADERS);
    expect(m.every(Boolean)).toBe(true);
    expect(new Set(m).size).toBe(m.length);
  });
  it("normalises headers and reports missing required fields", () => {
    expect(normalizeHeader(" E_mail  Address ")).toBe("emailaddress");
    expect(missingRequiredFields(["email"])).toHaveLength(1);
    expect(missingRequiredFields(["firstName", "lastName", "email"])).toEqual([]);
    expect(missingRequiredFields([null, null])).toHaveLength(2);
  });
  it("sanitises a user mapping: unknown keys dropped, fields used once", () => {
    expect(sanitizeMapping(["email", "email", "bogus", "city"], 5)).toEqual(["email", null, null, "city", null]);
  });
});

describe("row validation", () => {
  const map = ["legalName", "email", "dateOfBirth", "authType", "eadStart", "sevisId"];
  it("validates with the shared candidate schema and normalises values", () => {
    const r = validateRow(2, ["Ada Lovelace", "ADA@Example.com", "12/10/1998", "stem opt", "3/5/2026", "n001"], map, ALL);
    expect(r.errors).toEqual({});
    expect(r.input).toMatchObject({ legalName: "Ada Lovelace", email: "ada@example.com", dateOfBirth: "1998-12-10", authType: "STEM_OPT", eadStart: "2026-03-05" });
    expect(r.probe).toMatchObject({ email: "ada@example.com", sevisId: "N001", dateOfBirth: "1998-12-10" });
  });
  it("reports per-field errors", () => {
    const r = validateRow(3, ["A", "not-an-email", "31/31/1999", "wizard", "", ""], map, ALL);
    expect(Object.keys(r.errors).sort()).toEqual(["authType", "dateOfBirth", "email", "legalName"]);
    expect(r.input).toBeUndefined();
  });
  it("composes the legal name from first and last name", () => {
    const r = validateRow(2, ["Ada", "Lovelace", "ada@example.com"], ["firstName", "lastName", "email"], ALL);
    expect(r.input?.legalName).toBe("Ada Lovelace");
  });
  it("leaves out identifiers the importer may not store from duplicate probes, and warns about them", () => {
    const caps: ActorCaps = { sevis: false, ead: false, dob: false, immigrationEdit: false };
    const r = validateRow(2, ["Ada Lovelace", "ada@example.com", "1998-12-10", "", "", "N001"], map, caps);
    expect(r.probe.sevisId).toBeUndefined();
    expect(r.probe.dateOfBirth).toBeUndefined();
    expect(ignoredFields(map, caps)).toEqual(expect.arrayContaining(["SEVIS ID", "Date of Birth", "Authorization Type", "EAD Start"]));
    expect(ignoredFields(map, ALL)).toEqual([]);
  });
  it("parses authorization type spellings", () => {
    expect(parseAuthType("CPT")).toBe("CPT");
    expect(parseAuthType("STEM-OPT")).toBe("STEM_OPT");
    expect(parseAuthType("OPT")).toBe("OPT");
    expect(parseAuthType("")).toBe("none");
    expect(parseAuthType("H1B")).toBeNull();
  });
});

describe("in-file duplicate detection and commit planning", () => {
  const map = ["legalName", "email", "dateOfBirth", "sevisId"];
  const rows = [
    validateRow(2, ["Ada Lovelace", "ada@example.com", "1998-12-10", "N0001"], map, ALL),
    validateRow(3, ["Grace Hopper", "GRACE@example.com", "", ""], map, ALL),
    validateRow(4, ["Ada L", " Ada@Example.com ", "", ""], map, ALL), // same email as row 2
    validateRow(5, ["Someone", "other@example.com", "", "n0001"], map, ALL), // same SEVIS as row 2
    validateRow(6, ["ada  lovelace", "ada2@example.com", "1998-12-10", ""], map, ALL), // same name+DOB as row 2
    validateRow(7, ["X", "bad", "", ""], map, ALL), // invalid
    validateRow(8, ["Grace Hopper", "grace@example.com", "", ""], map, ALL), // same email as row 3
  ];
  const dups = detectInFileDuplicates(rows);

  it("flags later occurrences only, hard for email/SEVIS and soft for name+DOB", () => {
    expect(dups.has(2)).toBe(false);
    expect(dups.has(3)).toBe(false);
    expect(dups.get(4)).toMatchObject({ kind: "hard", ofRow: 2 });
    expect(dups.get(5)).toMatchObject({ kind: "hard", ofRow: 2 });
    expect(dups.get(6)).toMatchObject({ kind: "soft", ofRow: 2 });
    expect(dups.get(8)).toMatchObject({ kind: "hard", ofRow: 3 });
    expect(dups.has(7)).toBe(false);
  });
  it("lets an invalid row never claim an identifier", () => {
    const r = [
      validateRow(2, ["X", "dup@example.com", "", ""], map, { ...ALL }),
      validateRow(3, ["Valid Person", "dup@example.com", "", ""], map, ALL),
    ];
    r[0].errors = { legalName: "bad" };
    expect(detectInFileDuplicates(r).size).toBe(0);
  });
  it("classifies with database hits taking precedence for hard duplicates", () => {
    const row = rows[0];
    expect(classifyRow(row).status).toBe("valid");
    expect(classifyRow(rows[5]).status).toBe("invalid");
    expect(classifyRow(row, undefined, { kind: "hard", code: "CND-000001", reason: "Same email" }).status).toBe("duplicate_db");
    expect(classifyRow(row, { kind: "hard", ofRow: 1, reason: "x" }, { kind: "soft", code: "C", reason: "y" }).status).toBe("duplicate_file");
    expect(classifyRow(row, undefined, { kind: "soft", code: "C", reason: "y" }).status).toBe("possible_duplicate_db");
    expect(classifyRow(row, { kind: "soft", ofRow: 1, reason: "x" }).status).toBe("possible_duplicate_file");
  });
  it("skips duplicates by default; hard duplicates are never imported", () => {
    const statuses = rows.map((r) => ({ rowNumber: r.rowNumber, status: classifyRow(r, dups.get(r.rowNumber)).status }));
    const skip = planCommit(statuses, "skip");
    expect(skip.importRows).toEqual([2, 3]);
    const soft = planCommit(statuses, "import_soft");
    expect(soft.importRows).toEqual([2, 3, 6]);
    expect(soft.skipped.map((s) => s.rowNumber)).toEqual([4, 5, 7, 8]);
  });
});

describe("file parsing", () => {
  it("parses CSV with BOM, quotes, blank rows and duplicate headers", () => {
    const csv = '﻿Name,Email,Email\r\n"Lovelace, Ada",ada@example.com,x\r\n\r\n,,\r\nGrace,=cmd(),y\r\n';
    const s = parseCsv(csv);
    expect(s.headers).toEqual(["Name", "Email", "Email (2)"]);
    expect(s.rows).toEqual([
      ["Lovelace, Ada", "ada@example.com", "x"],
      ["Grace", "cmd()", "y"],
    ]);
    expect(s.neutralizedCells).toBe(1);
  });
  it("rejects empty, header-only and oversize inputs with clear errors", () => {
    expect(() => parseCsv("")).toThrow(ImportParseError);
    expect(() => parseCsv("Name,Email\n")).toThrow(/no data rows/);
    const big = "Name\n" + Array.from({ length: 5001 }, (_, i) => `n${i}`).join("\n");
    expect(() => parseCsv(big)).toThrow(/more than 5,000 rows/);
    expect(parseCsv("Name\n" + Array.from({ length: 5000 }, (_, i) => `n${i}`).join("\n")).rows).toHaveLength(5000);
  });
  it("rejects unsupported file types and mismatched content", async () => {
    await expect(parseRosterFile("roster.exe", Buffer.from("x"))).rejects.toThrow(/Unsupported/);
    await expect(parseRosterFile("roster.xlsx", Buffer.from("name,email"))).rejects.toThrow(/not a valid .xlsx/);
    await expect(parseRosterFile("roster.csv", Buffer.alloc(6 * 1024 * 1024, 65))).rejects.toThrow(/5 MB/);
  });
  it("parses XLSX: dates as date-only, formulas as cached results only", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Roster");
    ws.addRow(["Legal Name", "Email", "DOB", "Notes"]);
    ws.addRow(["Ada Lovelace", "ada@example.com", new Date(Date.UTC(1998, 11, 10)), { formula: "1+1", result: 2 }]);
    ws.addRow(["Grace Hopper", { text: "grace@example.com", hyperlink: "mailto:grace@example.com" }, 36000, "=evil()"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const s = await parseXlsx(buf);
    expect(s.headers).toEqual(["Legal Name", "Email", "DOB", "Notes"]);
    expect(s.rows[0]).toEqual(["Ada Lovelace", "ada@example.com", "1998-12-10", "2"]);
    expect(s.rows[1][1]).toBe("grace@example.com");
    expect(s.rows[1][3]).toBe("evil()");
    expect(normalizeDate(s.rows[1][2]).value).toBe("1998-07-24"); // serial 36000
  });
});
