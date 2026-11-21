import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

const roots = ["src/modules/payroll", "src/app/(app)/payroll", "src/app/(app)/emergency-payroll", "src/lib/payroll"];

describe("payroll status never implies work authorization (long spec §18)", () => {
  // rules.ts is the foundation engine (its "authorized manager" wording concerns override approvers, not work eligibility)
  const files = roots.flatMap((r) => walk(r)).filter((f) => !/lib[\\/]payroll[\\/]rules\.ts$/.test(f));
  it("covers the payroll module", () => expect(files.length).toBeGreaterThan(20));
  it("never uses the word 'authorized/authorization' in payroll code or UI copy, and never reads clearance fields", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src.toLowerCase(), f).not.toMatch(/authori[sz]/);
      expect(src, f).not.toMatch(/clearedToWork|clearance/);
    }
  });
  it("payroll modules never import immigration/compliance clearance logic", () => {
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/@\/lib\/compliance\/clearance/);
  });
});
