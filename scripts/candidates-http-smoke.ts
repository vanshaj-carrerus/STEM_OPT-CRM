/**
 * REAL HTTP test of the Candidate Management pages against a running Next.js dev server and a SCRATCH database
 * (synthetic candidates only, email forced to console). Verifies what is actually RENDERED and enforced per role.
 *
 *   npm run candidates:smoke
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch {}

const PORT = 3078;
const BASE = `http://localhost:${PORT}`;
const scratch = `dbtest_cand_${Date.now().toString(36)}`;
process.env.MONGODB_DB = scratch;
process.env.MAIL_MODE = "console";

let pass = 0;
let fail = 0;
const fails: string[] = [];
const check = (cond: unknown, msg: string) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    fails.push(msg);
    console.log(`  ✗ ${msg}`);
  }
};

let log = "";
let server: ChildProcess | null = null;
async function startServer() {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(PORT)], {
    env: { ...process.env, NEXT_DIST_DIR: ".next-smoke2", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d) => (log += d.toString()));
  server.stderr!.on("data", (d) => (log += d.toString()));
  const t0 = Date.now();
  while (!/Ready in|ready in/i.test(log)) {
    if (Date.now() - t0 > 90_000) throw new Error("dev server did not start:\n" + log.slice(-1500));
    if (server.exitCode !== null) throw new Error("dev server exited:\n" + log.slice(-1500));
    await new Promise((r) => setTimeout(r, 500));
  }
}
const stopServer = () => {
  if (server?.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  server = null;
};

/* ------------------------------ http helpers ------------------------------ */
type Cookie = string;
const get = async (path: string, cookie: Cookie) => {
  const res = await fetch(BASE + path, { redirect: "manual", headers: { cookie: `crm_session=${cookie}` } });
  return { res, text: await res.text(), status: res.status, loc: res.headers.get("location") ?? "" };
};
const json = async (method: string, path: string, cookie: Cookie, body?: unknown) => {
  const res = await fetch(BASE + path, { method, redirect: "manual", headers: { cookie: `crm_session=${cookie}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, res };
};
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
function actionFields(html: string, pick: RegExp = /./): [string, string][] {
  const forms = html.match(/<form[\s\S]*?<\/form>/g) ?? [];
  const form = forms.find((f) => /\$ACTION/.test(f) && pick.test(f));
  if (!form) throw new Error("no matching server-action form found");
  const out: [string, string][] = [];
  for (const m of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1];
    const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? "";
    if (name && name.startsWith("$ACTION")) out.push([name, decode(value)]);
  }
  return out;
}
const submit = async (path: string, hidden: [string, string][], fields: Record<string, string>, cookie: Cookie) => {
  const fd = new FormData();
  for (const [k, v] of hidden) fd.append(k, v);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(BASE + path, { method: "POST", body: fd, redirect: "manual", headers: { origin: BASE, cookie: `crm_session=${cookie}` } });
  return { status: res.status, text: await res.text(), loc: res.headers.get("location") ?? "" };
};
const rowIds = (html: string) => new Set([...html.matchAll(/href="\/candidates\/([0-9a-f-]{36})"/g)].map((m) => m[1]));
const isRedirect = (s: number) => s >= 300 && s < 400;
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/* ------------------------------ scenarios ------------------------------ */
async function main() {
  console.log(`Scratch database: ${scratch}\nStarting a throw-away dev server on :${PORT}…`);
  const { connectDb } = await import("../src/lib/db/connect");
  const mongoose = await connectDb();
  if (!mongoose.connection.name.startsWith("dbtest_")) throw new Error("Safety stop: not a scratch database");
  const { User } = await import("../src/lib/db/models/user");
  const { Session } = await import("../src/lib/db/models/session");
  const { Candidate } = await import("../src/lib/db/models/candidate");

  async function actor(role: "compliance_manager" | "compliance_associate" | "auditor" | "payroll_preparer" | "super_admin", name: string) {
    const u = await User.create({ name, email: `${role}@smoke.test`, role, passwordHash: "x", emailVerified: true });
    const token = randomBytes(24).toString("base64url");
    await Session.create({ userId: String(u._id), tokenHash: sha256(token), stage: "active", expiresAt: new Date(Date.now() + 12 * 3600_000), idleExpiresAt: new Date(Date.now() + 1800_000) });
    return { id: String(u._id), token, name };
  }
  const mgr = await actor("compliance_manager", "Smoke Manager");
  const assoc = await actor("compliance_associate", "Smoke Associate");
  const aud = await actor("auditor", "Smoke Auditor");
  const pay = await actor("payroll_preparer", "Smoke Payroll");
  const root = await actor("super_admin", "Smoke Root");

  await startServer();
  console.log("Server ready.\n");

  console.log("1. Create 27 synthetic candidates through the real API (as the Compliance Manager)");
  const created: { id: string; name: string }[] = [];
  const names = ["Anna Alpha", "bob beta", "Carla Gamma", "Dev Delta", "Eli Epsilon"];
  for (let i = 0; i < 27; i++) {
    const name = i < names.length ? names[i] : `Synthetic Person ${String(i).padStart(2, "0")}`;
    const r = await json("POST", "/api/candidates", mgr.token, {
      legalName: name,
      email: `smoke${i}@example.test`,
      phone: `+1 555 020 ${String(i).padStart(4, "0")}`,
      dateOfBirth: `199${i % 10}-0${(i % 9) + 1}-1${i % 9}`,
      school: i % 2 ? "Fictional State University" : "Imaginary Tech Institute",
      stage: i % 3 === 0 ? "active" : "new",
      authType: i % 4 === 0 ? "STEM_OPT" : i % 4 === 1 ? "OPT" : i % 4 === 2 ? "CPT" : "none",
      tagsCsv: i % 5 === 0 ? "alpha" : "",
      sevisId: `N00${String(i).padStart(8, "0")}`,
    });
    if (r.status !== 201) throw new Error(`create ${i} failed: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    created.push({ id: (r.data as { _id: string })._id, name });
  }
  check(created.length === 27, "27 candidates created (201 each)");
  // give the associate two of them
  await Candidate.updateMany({ _id: { $in: [created[1].id, created[2].id] } }, { $set: { ownerId: assoc.id } });

  console.log("\n2. Candidate LIST page as the manager: rows, search, filters, sort, pagination");
  let r = await get("/candidates", mgr.token);
  check(r.status === 200, "GET /candidates → 200");
  check(rowIds(r.text).size === 25, `page 1 shows 25 rows (got ${rowIds(r.text).size})`);
  check(/27 candidates/.test(r.text.replace(/<!-- -->/g, "")) && /page 1 of 2/.test(r.text.replace(/<!-- -->/g, "")), "footer says 27 candidates · page 1 of 2");
  r = await get("/candidates?page=2", mgr.token);
  check(rowIds(r.text).size === 2, `page 2 shows the remaining 2 rows (got ${rowIds(r.text).size})`);
  const page1 = rowIds((await get("/candidates?sort=name", mgr.token)).text);
  const page2 = rowIds((await get("/candidates?sort=name&page=2", mgr.token)).text);
  check(new Set([...page1, ...page2]).size === 27, "name-sorted pages 1+2 contain all 27 candidates exactly once");
  r = await get("/candidates?q=carla", mgr.token);
  check(rowIds(r.text).size === 1 && r.text.includes("Carla Gamma"), "search 'carla' finds exactly Carla Gamma");
  r = await get("/candidates?q=zzz-nothing", mgr.token);
  check(rowIds(r.text).size === 0 && /No candidates found/.test(r.text), "search with no match shows the empty state");
  r = await get("/candidates?stage=active", mgr.token);
  const activeExpected = created.filter((_, i) => i % 3 === 0).length;
  check(rowIds(r.text).size === activeExpected, `stage=active shows ${activeExpected} rows (got ${rowIds(r.text).size})`);
  r = await get("/candidates?authType=CPT", mgr.token);
  check(rowIds(r.text).size === created.filter((_, i) => i % 4 === 2).length, "authorization filter CPT shows the right rows");
  r = await get("/candidates?tag=alpha", mgr.token);
  check(rowIds(r.text).size === 6, "tag filter shows the right rows");
  r = await get("/candidates?sort=name", mgr.token);
  const firstNames = [...r.text.matchAll(/href="\/candidates\/[0-9a-f-]{36}"[^>]*>([^<]+)</g)].map((m) => m[1]);
  check(firstNames[0] === "Anna Alpha" && firstNames[1] === "bob beta", `name sort is case-insensitive (first rows: ${firstNames.slice(0, 3).join(", ")})`);
  r = await get("/candidates?page=999", mgr.token);
  check(r.status === 200 && rowIds(r.text).size === 0, "an out-of-range page renders cleanly (no crash)");
  r = await get("/candidates?page=abc&sort=bogus&stage=%7B%24ne%3Anull%7D", mgr.token);
  check(r.status === 200, "garbage query parameters never crash the page");

  console.log("\n3. Export buttons and the export download");
  r = await get("/candidates", mgr.token);
  check(/Export CSV/.test(r.text) && /Export incl\. restricted/.test(r.text), "manager sees 'Export CSV' and 'Export incl. restricted'");
  check(/href="\/api\/candidates\/export\?/.test(r.text), "the export link carries the current filters");
  r = await get("/candidates?stage=active", mgr.token);
  check(/export\?stage=active/.test(decode(r.text)), "the export link for a filtered list contains stage=active");
  const exp = await get("/api/candidates/export?stage=active", mgr.token);
  const lines = exp.text.replace(/^﻿/, "").trim().split(/\r?\n/);
  check(exp.status === 200 && lines.length === 1 + activeExpected, `CSV has a header + ${activeExpected} active rows (got ${lines.length - 1})`);
  check(!exp.text.includes("N00000000") && !/Date of Birth/.test(lines[0]), "default CSV has no SEVIS ID / date-of-birth columns");
  const expS = await get("/api/candidates/export?includeSensitive=1&q=Carla", mgr.token);
  check(/SEVIS ID/.test(expS.text) && /N0000000002/.test(expS.text), "restricted export (manager) includes SEVIS ID for the filtered rows");
  r = await get("/candidates", root.token);
  check(/Export CSV/.test(r.text) && !/Export incl\. restricted/.test(r.text), "Super Admin has Export CSV but NOT the restricted export (no sensitive permissions)");
  r = await get("/candidates", assoc.token);
  check(!/Export CSV/.test(r.text) && !/Import/.test(r.text.replace(/Imaginary/g, "")), "associate sees neither Export nor Import");
  r = await get("/candidates", aud.token);
  check(!/Export CSV/.test(r.text) && !/New candidate/.test(r.text), "auditor sees neither Export nor 'New candidate'");
  check((await get("/api/candidates/export", assoc.token)).status === 403, "associate calling the export API directly → 403");
  check((await get("/api/candidates/export", aud.token)).status === 403, "auditor calling the export API directly → 403");

  console.log("\n4. Associate: only assigned candidates");
  r = await get("/candidates", assoc.token);
  check(rowIds(r.text).size === 2, `associate's list shows only their 2 assigned candidates (got ${rowIds(r.text).size})`);
  check((await get(`/candidates/${created[1].id}`, assoc.token)).status === 200, "associate can open an assigned profile");
  r = await get(`/candidates/${created[5].id}`, assoc.token);
  check(r.status === 404 || r.text.includes("could not be found") || r.text.includes("404"), `associate opening someone else's profile → not found (status ${r.status})`);
  check((await get(`/candidates/${created[5].id}/edit`, assoc.token)).status === 404, "…and cannot open its edit page either");
  r = await get("/candidates?q=Dev%20Delta", assoc.token);
  check(rowIds(r.text).size === 0, "search by the associate cannot reach unassigned candidates (Dev Delta exists but is not theirs)");
  r = await get("/candidates?q=Carla", assoc.token);
  check(rowIds(r.text).size === 1, "…while an assigned one (Carla Gamma) is found");

  console.log("\n5. Candidate PROFILE (manager): overview summaries and every tab renders");
  const target = created[0];
  r = await get(`/candidates/${target.id}`, mgr.token);
  const text = r.text;
  check(r.status === 200 && text.includes("Anna Alpha"), "profile renders with the candidate's name");
  for (const label of ["Identity &amp; contact", "Education", "Immigration summary", "Employment", "Case notes", "Contact history", "Operations", "Document checklist"]) {
    check(text.includes(label), `overview shows the "${label.replace("&amp;", "&")}" section`);
  }
  check(/CND-\d{6}/.test(text), "internal candidate ID is displayed");
  check(!/v1:[A-Za-z0-9_-]{6,}/.test(text) && !text.includes("N00000000"), "no ciphertext or plaintext SEVIS appears in the page");
  for (const tab of ["immigration", "documents", "employment", "tracker", "tasks", "activity"]) {
    const t = await get(`/candidates/${target.id}?tab=${tab}`, mgr.token);
    check(t.status === 200 && !/Application error|Internal Server Error/i.test(t.text), `tab "${tab}" renders (200)`);
  }
  check((await get(`/candidates/${target.id}/edit`, mgr.token)).status === 200, "edit page renders");

  console.log("\n6. Create and edit through the real forms (server actions)");
  const page = await get("/candidates/new", mgr.token);
  check(page.status === 200 && /Legal name/.test(page.text), "GET /candidates/new renders the form");
  let s = await submit("/candidates/new", actionFields(page.text, /name="legalName"/), { legalName: "Form Created", email: "form.created@example.test", stage: "new", priority: "normal", authType: "none", school: "Form University" }, mgr.token);
  check(isRedirect(s.status) && /^\/candidates\/[0-9a-f-]{36}$/.test(s.loc.replace(BASE, "")), `submitting the form creates the candidate and redirects to the profile (${s.status} ${s.loc})`);
  const newId = s.loc.replace(BASE, "").split("/").pop()!;
  check(!!(await Candidate.findById(newId).lean()), "the new candidate is saved in MongoDB");
  s = await submit("/candidates/new", actionFields(page.text, /name="legalName"/), { legalName: "Form Created Again", email: "FORM.created@example.test", stage: "new", priority: "normal", authType: "none" }, mgr.token);
  check(s.status === 200 && /Duplicate candidate/.test(s.text) && /Same email/.test(s.text), "creating a duplicate email shows the duplicate warning and saves nothing");
  check((await Candidate.countDocuments({ emailLower: "form.created@example.test" })) === 1, "still exactly one record for that email");
  s = await submit("/candidates/new", actionFields(page.text, /name="legalName"/), { legalName: "A", email: "bad", stage: "new", priority: "normal", authType: "none" }, mgr.token);
  check(s.status === 200 && /fix the highlighted fields/i.test(s.text), "invalid input re-renders the form with an error (no redirect)");
  const edit = await get(`/candidates/${newId}/edit`, mgr.token);
  s = await submit(`/candidates/${newId}/edit`, actionFields(edit.text, /name="phone"/), { id: newId, phone: "+1 555 020 9999", stage: "active" }, mgr.token);
  check(isRedirect(s.status), `submitting the edit form redirects back to the profile (${s.status})`);
  const after = await Candidate.findById(newId).lean<{ phone?: string; stage?: string; school?: string }>();
  check(after?.phone === "+1 555 020 9999" && after?.stage === "active" && after?.school === "Form University", "edit saved: phone + stage changed, school untouched");

  console.log("\n7. Role-based pages");
  check(isRedirect((await get("/candidates/new", aud.token)).status), "auditor opening /candidates/new is redirected away");
  check(isRedirect((await get("/candidates/new", pay.token)).status), "payroll preparer opening /candidates/new is redirected away");
  check(isRedirect((await get(`/candidates/${target.id}/edit`, aud.token)).status), "auditor opening an edit page is redirected away");
  check(isRedirect((await get("/candidates/import", assoc.token)).status), "associate opening /candidates/import is redirected away");
  check((await get("/candidates/import", mgr.token)).status === 200, "manager can open the import page");
  r = await get("/candidates/import", mgr.token);
  check(/master roster/i.test(r.text), "the import page carries the approved-master-roster warning");
  r = await get(`/candidates/${target.id}`, pay.token);
  check(r.status === 200 && r.text.includes("Anna Alpha") && !/Immigration summary/.test(r.text) && !/Case notes/.test(r.text) && !/Contact history/.test(r.text), "payroll preparer sees the profile WITHOUT immigration summary, case notes or contact history");
  r = await get(`/candidates/${target.id}`, aud.token);
  check(r.status === 200 && /Immigration summary/.test(r.text) && !/Edit<\/a>|href="\/candidates\/[0-9a-f-]+\/edit"/.test(r.text), "auditor sees the compliance data but no Edit button");
  r = await get("/candidates", pay.token);
  check(!/Authorization<\/th>/.test(r.text), "payroll preparer's list has no Authorization column");
  check((await get("/candidates", "forged")).status !== 200, "a forged session cannot open the list");

  console.log("\n8. Raw API checks over HTTP");
  check((await json("GET", "/api/candidates", "forged")).status === 401, "forged cookie → 401 on the list API");
  const bad = await fetch(BASE + "/api/candidates", { method: "POST", headers: { cookie: `crm_session=${mgr.token}`, "content-type": "application/json" }, body: "{oops" });
  check(bad.status === 400, `malformed JSON → 400 (got ${bad.status})`);
  check((await json("POST", "/api/candidates", aud.token, { legalName: "Nope Nope", email: "nope@example.test" })).status === 403, "auditor POST /api/candidates → 403");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("FAILURES:");
    for (const f of fails) console.log("  - " + f);
  }
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  stopServer();
  rmSync(".next-smoke2", { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error("\nSMOKE TEST CRASHED:", (e as Error).message);
  console.error("--- last server output ---\n" + log.slice(-2000));
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.name?.startsWith("dbtest_")) await mongoose.connection.dropDatabase();
  } catch {}
  stopServer();
  rmSync(".next-smoke2", { recursive: true, force: true });
  process.exit(1);
});
