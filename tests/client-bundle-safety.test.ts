import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Client components must never import server-only modules (Mongoose, models, services) — it breaks the browser bundle. */
function walk(dir: string, out: string[] = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

const FORBIDDEN = /from\s+["'](@\/lib\/db\/|@\/lib\/audit|@\/lib\/auth\/(session|guard|otp|ratelimit)|@\/lib\/mail|@\/lib\/storage|mongoose|nodemailer|node:)/;
const isClient = (src: string) => /^["']use client["']/.test(src.trimStart());

describe("client components stay free of server-only imports", () => {
  const files = walk("src").filter((f) => isClient(readFileSync(f, "utf8")));
  it("found client components to check", () => expect(files.length).toBeGreaterThan(5));
  for (const f of files) {
    it(f.split("\\").join("/"), () => {
      const bad = readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => FORBIDDEN.test(l));
      expect(bad).toEqual([]);
    });
  }
});
