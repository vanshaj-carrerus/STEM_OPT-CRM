import { describe, expect, it } from "vitest";
import { centsToInput, formatCents, parseMoneyToCents } from "@/lib/payroll/money";
import { computeItemFlags, parseAmountCsv, parseRegisterCsv } from "@/lib/payroll/register-csv";

describe("money is integer cents, never floats", () => {
  it("parses common formats exactly", () => {
    expect(parseMoneyToCents("1234.56")).toBe(123456);
    expect(parseMoneyToCents("$1,234.5")).toBe(123450);
    expect(parseMoneyToCents("(12.30)")).toBe(-1230);
    expect(parseMoneyToCents("-5")).toBe(-500);
    expect(parseMoneyToCents("0.1")).toBe(10);
    expect(parseMoneyToCents("19.99")).toBe(1999); // would be 1998.9999 with float math
  });
  it("rejects blank, junk and sub-cent precision", () => {
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("1.234")).toBeNull();
    expect(parseMoneyToCents("1e3")).toBeNull();
  });
  it("formats and round-trips", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-5)).toBe("-$0.05");
    expect(formatCents(null)).toBe("—");
    expect(centsToInput(123456)).toBe("1234.56");
  });
});

const GOOD = [
  "Employee ID,Employee Name,Pay Type,Hours,Gross Pay,Net Pay,Bonus,Deductions,Notes",
  "g-100,Asha Rao,Hourly,80,\"$2,000.00\",1500.50,0,100,",
  "g-101,Li Wei,Salary,,3000,2400,250.00,50.25,Spot bonus",
].join("\n");

describe("Gusto register CSV parsing", () => {
  it("parses rows into cents with per-row validation", () => {
    const r = parseRegisterCsv(GOOD);
    expect(r.headerErrors).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ externalEmployeeRef: "g-100", hours: 80, payType: "hourly", grossCents: 200000, netCents: 150050, deductionsCents: 10000 });
    expect(r.rows[1]).toMatchObject({ payType: "salary", hours: null, bonusesCents: 25000, deductionsCents: 5025, notes: "Spot bonus" });
    expect(r.rows.every((x) => x.errors.length === 0)).toBe(true);
    expect(r.rows[1].flags).not.toContain("missing_hours"); // salary needs no hours
  });
  it("sums regular + overtime hours when there is no total column", () => {
    const r = parseRegisterCsv("employee id,regular hours,overtime hours,net pay\nx1,40,5.5,100");
    expect(r.rows[0].hours).toBe(45.5);
  });
  it("requires an employee id and an amount column", () => {
    expect(parseRegisterCsv("Name,Gross Pay\nA,1").headerErrors.join()).toMatch(/employee ID/i);
    expect(parseRegisterCsv("Employee ID,Name\nA,B").headerErrors.join()).toMatch(/gross or net/i);
    expect(parseRegisterCsv("").headerErrors.length).toBe(1);
  });
  it("never reads tax IDs, bank or address columns — they are reported as ignored", () => {
    const r = parseRegisterCsv("Employee ID,SSN,Routing Number,Bank Account Number,Home Address,Net Pay\ng1,123-45-6789,021000021,12345678,1 Main St,100");
    expect(r.ignoredColumns).toEqual(expect.arrayContaining(["SSN", "Routing Number", "Bank Account Number", "Home Address"]));
    expect(JSON.stringify(r.rows)).not.toMatch(/123-45-6789|021000021|12345678|Main St/);
  });
  it("rejects tax-identifier-looking employee IDs and duplicates, and bad amounts", () => {
    const r = parseRegisterCsv("Employee ID,Net Pay\n123-45-6789,10\nA1,10\nA1,11\nB1,12.345");
    expect(r.rows[0].errors.join()).toMatch(/tax identifier/);
    expect(r.rows[2].errors.join()).toMatch(/Duplicate/);
    expect(r.rows[3].errors.join()).toMatch(/Invalid net pay/);
    expect(r.rows[1].errors).toEqual([]);
  });
  it("raises exception flags instead of failing the row", () => {
    expect(computeItemFlags({ payType: "hourly", hours: null, grossCents: 100, netCents: 200, matched: false })).toEqual(
      expect.arrayContaining(["unmatched_employee", "missing_hours", "net_exceeds_gross"]),
    );
    expect(computeItemFlags({ payType: "salary", hours: 300, grossCents: null, netCents: -1, matched: true })).toEqual(
      expect.arrayContaining(["high_hours", "negative_net"]),
    );
    expect(computeItemFlags({ payType: "salary", hours: null, grossCents: null, netCents: null, matched: true })).toContain("missing_amounts");
  });
});

describe("settlement / provider amount CSV", () => {
  it("sums the amount column exactly and collects references", () => {
    const r = parseAmountCsv("Reference,Amount\nTRC1,\"1,000.10\"\nTRC2,0.20\nTRC3,bad");
    expect(r.totalCents).toBe(100030);
    expect(r.count).toBe(2);
    expect(r.references).toEqual(["TRC1", "TRC2"]);
    expect(r.errors).toHaveLength(1);
  });
  it("needs an amount column", () => {
    expect(parseAmountCsv("a,b\n1,2").errors[0]).toMatch(/amount/i);
  });
});
