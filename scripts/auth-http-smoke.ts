/**
 * REAL HTTP end-to-end test of authentication against a running Next.js dev server (proxy, cookies, redirects, server
 * actions, API routes) — all against a SCRATCH database, with email forced to console mode (nothing is ever sent).
 *
 *   npm run auth:smoke
 *
 * The server actions are exercised the way a browser without JavaScript does it: GET the page, take the hidden
 * `$ACTION_*` form fields, POST them back with the user's input.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch {}

const PORT = 3077;
const BASE = `http://localhost:${PORT}`;
const scratch = `dbtest_http_${Date.now().toString(36)}`;
process.env.MONGODB_DB = scratch;
process.env.MAIL_MODE = "console";
const GOOD = "Str0ng-Password-2026!";

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

/* ------------------------------ server ------------------------------ */

let log = "";
let server: ChildProcess | null = null;

async function startServer() {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(PORT)], {
    env: { ...process.env, NEXT_DIST_DIR: ".next-smoke", NEXT_TELEMETRY_DISABLED: "1" },
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

function stopServer() {
  if (server?.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  server = null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const lastCode = () => {
  const all = [...log.matchAll(/Your verification code is: (\d{6})/g)];
  if (!all.length) throw new Error("no code in server log");
  return all.at(-1)![1];
};
const codeCount = () => [...log.matchAll(/Your verification code is: (\d{6})/g)].length;

/* ------------------------------ http helpers ------------------------------ */

const jar: Record<string, string> = {};
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
const rawSetCookie: string[] = [];

function absorb(res: Response) {
  for (const sc of res.headers.getSetCookie()) {
    rawSetCookie.push(sc);
    const [pair] = sc.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i);
    const value = pair.slice(i + 1);
    if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(sc)) delete jar[name];
    else jar[name] = value;
  }
}

async function get(path: string, opts: { cookie?: string } = {}) {
  const res = await fetch(BASE + path, { redirect: "manual", headers: { cookie: opts.cookie ?? cookieHeader() } });
  absorb(res);
  return { res, text: await res.text() };
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Hidden `$ACTION_*` inputs of the first <form> whose HTML matches `pick`. */
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

async function submit(path: string, hidden: [string, string][], fields: Record<string, string>, opts: { cookie?: string } = {}) {
  const fd = new FormData();
  for (const [k, v] of hidden) fd.append(k, v);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(BASE + path, { method: "POST", body: fd, redirect: "manual", headers: { origin: BASE, cookie: opts.cookie ?? cookieHeader() } });
  absorb(res);
  return { res, text: await res.text(), location: res.headers.get("location") ?? "" };
}

const isRedirect = (s: number) => s >= 300 && s < 400;
const pathOf = (loc: string) => (loc.startsWith("http") ? new URL(loc).pathname + new URL(loc).search : loc);

/* ------------------------------ scenarios ------------------------------ */

async function main() {
  console.log(`Scratch database: ${scratch}\nStarting a throw-away dev server on :${PORT} (email = console mode, nothing is sent)…`);
  const { connectDb } = await import("../src/lib/db/connect");
  const mongoose = await connectDb();
  if (!mongoose.connection.name.startsWith("dbtest_")) throw new Error("Safety stop: not a scratch database");
  const { User } = await import("../src/lib/db/models/user");
  const { Session } = await import("../src/lib/db/models/session");
  const { hashPassword } = await import("../src/lib/auth/password");
  const { LOGIN_FAILED_MESSAGE } = await import("../src/lib/auth/lockout");
  const failedMsg = decode(LOGIN_FAILED_MESSAGE);

  const alice = await User.create({ name: "Alice Tester", email: "alice@smoke.test", role: "compliance_manager", passwordHash: await hashPassword(GOOD), emailVerified: true });
  await User.create({ name: "Bob Locked", email: "bob@smoke.test", role: "compliance_manager", passwordHash: await hashPassword(GOOD), emailVerified: true });

  await startServer();
  console.log("Server ready.\n");

  console.log("1. Public pages and the gate");
  let r = await get("/login", { cookie: "" });
  check(r.res.status === 200 && /\$ACTION/.test(r.text), "GET /login renders the sign-in form");
  check(r.res.headers.get("x-frame-options") === "DENY" && r.res.headers.get("x-content-type-options") === "nosniff", "security headers are set (X-Frame-Options, nosniff)");
  check(!/x-powered-by/i.test([...r.res.headers.keys()].join(",")), "no X-Powered-By header");
  r = await get("/dashboard", { cookie: "" });
  check(isRedirect(r.res.status) && pathOf(r.res.headers.get("location")!).startsWith("/login"), "GET /dashboard without a session → redirect to /login");
  r = await get("/api/tasks", { cookie: "" });
  check(r.res.status === 401, `GET /api/tasks without a session → 401 (got ${r.res.status})`);
  r = await get("/api/candidates", { cookie: "crm_session=forged-token" });
  check(r.res.status === 401, `GET /api/candidates with a forged cookie → 401 (got ${r.res.status})`);
  r = await get("/dashboard", { cookie: "crm_session=forged-token" });
  check(isRedirect(r.res.status) && pathOf(r.res.headers.get("location")!).startsWith("/login"), "GET /dashboard with a forged cookie → redirect to /login");

  console.log("\n2. Sign-in: generic errors");
  const login = async (email: string, password: string) => {
    const page = await get("/login", { cookie: cookieHeader() });
    return submit("/login", actionFields(page.text), { email, password });
  };
  let s = await login("alice@smoke.test", "wrong-password");
  check(s.res.status === 200 && s.text.includes(failedMsg), "wrong password → the generic message");
  const wrongBody = s.text.includes(failedMsg);
  s = await login("nobody@smoke.test", "wrong-password");
  check(wrongBody && s.text.includes(failedMsg), "unknown email → the IDENTICAL generic message (no enumeration)");
  check(Object.keys(jar).length === 0, "no cookie is issued for failed sign-ins");

  console.log("\n3. Password → OTP stage → app access only after the code");
  const before = codeCount();
  s = await login("alice@smoke.test", GOOD);
  check(isRedirect(s.res.status) && pathOf(s.location) === "/verify-otp", `correct password → redirect to /verify-otp (got ${s.res.status} ${s.location})`);
  const sc = rawSetCookie.find((c) => c.startsWith("crm_session="))!;
  check(!!sc && /httponly/i.test(sc) && /samesite=lax/i.test(sc) && /path=\//i.test(sc), "session cookie is HttpOnly; SameSite=Lax; Path=/");
  check(codeCount() === before + 1, "a six-digit code was emailed (console mode)");
  const otpCookie = jar["crm_session"];
  r = await get("/dashboard");
  check(isRedirect(r.res.status) && pathOf(r.res.headers.get("location")!).startsWith("/login"), "with only the OTP-stage cookie, /dashboard is still refused");
  r = await get("/api/tasks");
  check(r.res.status === 401, "with only the OTP-stage cookie, the API answers 401");
  r = await get("/verify-otp");
  check(r.res.status === 200 && /Check your email/.test(r.text), "the /verify-otp page renders for a pending sign-in");

  const otpPage = await get("/verify-otp");
  const bad = lastCode() === "000000" ? "111111" : "000000";
  s = await submit("/verify-otp", actionFields(otpPage.text), { code: bad });
  check(s.res.status === 200 && /Incorrect code/.test(s.text), "wrong code → 'Incorrect code' and no access");
  r = await get("/dashboard");
  check(isRedirect(r.res.status), "still no dashboard access after a wrong code");

  s = await submit("/verify-otp", actionFields(otpPage.text), { code: lastCode() });
  check(isRedirect(s.res.status) && pathOf(s.location) === "/dashboard", `correct code → redirect to /dashboard (got ${s.res.status} ${s.location})`);
  check(jar["crm_session"] && jar["crm_session"] !== otpCookie, "the session token is ROTATED on successful verification");
  const activeCookie = jar["crm_session"];

  r = await get("/dashboard");
  check(r.res.status === 200 && /Welcome, Alice/.test(r.text), "authenticated: /dashboard renders");
  r = await get("/candidates");
  check(r.res.status === 200, "authenticated: /candidates renders");
  r = await get("/api/tasks");
  check(r.res.status === 200, `authenticated: /api/tasks → 200 (got ${r.res.status})`);

  const used = lastCode();
  const otpReplay = (async () => {
    // sign in again in a clean browser and try the already-used code
    const saved = { ...jar };
    for (const k of Object.keys(jar)) delete jar[k];
    s = await login("alice@smoke.test", GOOD);
    const p = await get("/verify-otp");
    const rep = await submit("/verify-otp", actionFields(p.text), { code: used });
    for (const k of Object.keys(jar)) delete jar[k];
    Object.assign(jar, saved);
    return rep;
  })();
  const rep = await otpReplay;
  check(rep.res.status === 200 && !isRedirect(rep.res.status), "an already-used code cannot be replayed");

  console.log("\n4. Idle timeout, absolute expiry and logout (real cookies)");
  await Session.updateMany({ userId: String(alice._id), stage: "active" }, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
  r = await get("/dashboard", { cookie: `crm_session=${activeCookie}` });
  check(isRedirect(r.res.status) && pathOf(r.res.headers.get("location")!).startsWith("/login"), "after 30 min of inactivity the page redirects to /login");
  r = await get("/api/tasks", { cookie: `crm_session=${activeCookie}` });
  check(r.res.status === 401, "after the idle timeout the API answers 401");

  for (const k of Object.keys(jar)) delete jar[k];
  s = await login("alice@smoke.test", GOOD);
  let p2 = await get("/verify-otp");
  await submit("/verify-otp", actionFields(p2.text), { code: lastCode() });
  const cookie2 = jar["crm_session"];
  await Session.updateMany({ userId: String(alice._id), stage: "active" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  r = await get("/api/tasks", { cookie: `crm_session=${cookie2}` });
  check(r.res.status === 401, "after the 12-hour absolute limit the API answers 401");

  for (const k of Object.keys(jar)) delete jar[k];
  await login("alice@smoke.test", GOOD);
  p2 = await get("/verify-otp");
  await submit("/verify-otp", actionFields(p2.text), { code: lastCode() });
  const cookie3 = jar["crm_session"];
  const dash = await get("/dashboard");
  s = await submit("/dashboard", actionFields(dash.text, /Sign out/), {});
  check(isRedirect(s.res.status) && pathOf(s.location) === "/login", `logout → redirect to /login (got ${s.res.status} ${s.location})`);
  check(!jar["crm_session"], "logout clears the cookie");
  r = await get("/api/tasks", { cookie: `crm_session=${cookie3}` });
  check(r.res.status === 401, "the logged-out cookie is dead on the server (replay → 401)");
  check((await Session.countDocuments({ tokenHash: sha256(cookie3) })) === 0, "the logged-out session row is deleted from the database");

  console.log("\n5. Lockout over HTTP");
  for (const k of Object.keys(jar)) delete jar[k];
  for (let i = 0; i < 5; i++) await login("bob@smoke.test", "wrong-" + i);
  const bob = await User.findOne({ email: "bob@smoke.test" }).lean();
  check(bob?.failedLogins === 5 && !!bob.lockedUntil, "5 wrong passwords lock the account (database confirms)");
  const codesBefore = codeCount();
  s = await login("bob@smoke.test", GOOD);
  check(s.res.status === 200 && s.text.includes(failedMsg) && !isRedirect(s.res.status), "the CORRECT password is refused while locked, with the same generic message");
  check(codeCount() === codesBefore && !jar["crm_session"], "no code is emailed and no session is created for a locked account");

  console.log("\n6. Password reset over HTTP");
  for (const k of Object.keys(jar)) delete jar[k];
  const fp = await get("/forgot-password");
  const reqFields = actionFields(fp.text);
  const codesBeforeReset = codeCount();
  const known = await submit("/forgot-password", reqFields, { email: "alice@smoke.test" });
  await sleep(2500); // the reset email is sent AFTER the response (so response time never reveals the account)
  const knownCodes = codeCount();
  check(knownCodes === codesBeforeReset + 1, "the real account receives exactly one reset code (sent after the response)");
  const unknown = await submit("/forgot-password", reqFields, { email: "ghost@smoke.test" });
  await sleep(2500);
  const msg = (t: string) => /If that account exists, a reset code has been emailed\./.test(t);
  check(known.res.status === 200 && unknown.res.status === 200 && msg(known.text) && msg(unknown.text), "known and unknown emails get the identical 'If that account exists…' response");
  check(codeCount() === knownCodes, "no email is produced for the unknown address");
  const resetCode = lastCode();
  const resetFields = actionFields(known.text, /name="code"/);
  const NEW = "Brand-New-Passw0rd!";
  s = await submit("/forgot-password", resetFields, { email: "alice@smoke.test", code: resetCode === "000000" ? "111111" : "000000", password: NEW });
  check(!isRedirect(s.res.status) && /Invalid or expired code/.test(s.text), "wrong reset code → 'Invalid or expired code.'");
  s = await submit("/forgot-password", resetFields, { email: "alice@smoke.test", code: resetCode, password: "weak" });
  check(/Password must include/.test(s.text), "weak password for a regular user is refused (code not burned)");
  s = await submit("/forgot-password", resetFields, { email: "alice@smoke.test", code: resetCode, password: NEW });
  check(isRedirect(s.res.status) && pathOf(s.location).startsWith("/login"), `valid code + strong password → /login?reset=1 (got ${s.res.status} ${s.location})`);
  s = await submit("/forgot-password", resetFields, { email: "alice@smoke.test", code: resetCode, password: "Another-Passw0rd!!" });
  check(!isRedirect(s.res.status) && /Invalid or expired code/.test(s.text), "the reset code cannot be used a second time");
  s = await login("alice@smoke.test", GOOD);
  check(s.text.includes(failedMsg), "the OLD password no longer works");
  s = await login("alice@smoke.test", NEW);
  check(isRedirect(s.res.status) && pathOf(s.location) === "/verify-otp", "the NEW password works (then the emailed code is required again)");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("FAILURES:");
    for (const f of fails) console.log("  - " + f);
  }
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  stopServer();
  rmSync(".next-smoke", { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error("\nSMOKE TEST CRASHED:", (e as Error).message);
  console.error("--- last server output ---\n" + log.slice(-1500));
  try {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.name?.startsWith("dbtest_")) await mongoose.connection.dropDatabase();
  } catch {}
  stopServer();
  rmSync(".next-smoke", { recursive: true, force: true });
  process.exit(1);
});
