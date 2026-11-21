import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCollections, startTestDb, stopTestDb } from "../helpers/db";

/**
 * Authentication end-to-end tests against a SCRATCH database (never the real one).
 * Only the Next.js request plumbing is mocked (cookies / headers); the real server actions, session store, lockout,
 * OTP, rate limiter, route wrapper and proxy all run.
 */
const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  const opts = new Map<string, Record<string, unknown>>();
  const hdrs = new Map<string, string>();
  const jar = {
    get: (n: string) => (store.has(n) ? { name: n, value: store.get(n)! } : undefined),
    set: (n: string, v: string, o?: Record<string, unknown>) => {
      store.set(n, v);
      opts.set(n, o ?? {});
    },
    delete: (n: string) => {
      store.delete(n);
    },
  };
  return { store, opts, hdrs, jar };
});

vi.mock("@/lib/request-context", () => ({
  requestCookies: async () => h.jar,
  requestHeaders: async () => ({ get: (k: string) => h.hdrs.get(k.toLowerCase()) ?? null }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => h.jar,
  headers: async () => ({ get: (k: string) => h.hdrs.get(k.toLowerCase()) ?? null }),
}));

type Actions = typeof import("@/lib/auth/actions");
let A: Actions;
let sessionMod: typeof import("@/lib/auth/session");
let mail: typeof import("@/lib/mail");
let M: {
  User: typeof import("@/lib/db/models/user").User;
  Session: typeof import("@/lib/db/models/session").Session;
  Otp: typeof import("@/lib/db/models/otp").OtpChallenge;
  Audit: typeof import("@/lib/db/models/audit").AuditEvent;
};
let lockout: typeof import("@/lib/auth/lockout");
let hashPassword: typeof import("@/lib/auth/password").hashPassword;
let rateLimit: typeof import("@/lib/auth/ratelimit").rateLimit;

const GOOD = "Str0ng-Password-2026!";
const COOKIE = "crm_session";

beforeAll(async () => {
  await startTestDb();
  A = await import("@/lib/auth/actions");
  sessionMod = await import("@/lib/auth/session");
  mail = await import("@/lib/mail");
  lockout = await import("@/lib/auth/lockout");
  hashPassword = (await import("@/lib/auth/password")).hashPassword;
  rateLimit = (await import("@/lib/auth/ratelimit")).rateLimit;
  M = {
    User: (await import("@/lib/db/models/user")).User,
    Session: (await import("@/lib/db/models/session")).Session,
    Otp: (await import("@/lib/db/models/otp")).OtpChallenge,
    Audit: (await import("@/lib/db/models/audit")).AuditEvent,
  };
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearCollections();
  h.store.clear();
  h.opts.clear();
  h.hdrs.clear();
  h.hdrs.set("x-forwarded-for", "10.0.0.1");
  h.hdrs.set("user-agent", "vitest");
  mail.devOutbox.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined); // the dev mail fallback prints codes
});

/* ------------------------------ helpers ------------------------------ */

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/** Run a server action and report the redirect target (Next implements redirect() by throwing). */
async function run<T>(p: Promise<T>): Promise<{ redirect: string | null; result?: T }> {
  try {
    return { redirect: null, result: await p };
  } catch (e) {
    const digest = String((e as { digest?: string }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] };
    throw e;
  }
}

async function makeUser(email = "alice@example.com", role: "compliance_manager" | "super_admin" | "auditor" = "compliance_manager", password = GOOD, extra: Record<string, unknown> = {}) {
  return M.User.create({ name: "Alice Tester", email, role, passwordHash: await hashPassword(password), emailVerified: true, ...extra });
}

const login = (email: string, password: string) => run(A.loginAction({}, fd({ email, password })));
const lastCode = () => {
  const m = mail.devOutbox.at(-1)?.text.match(/verification code is: (\d{6})/);
  if (!m) throw new Error("no code email was sent");
  return m[1];
};
const verify = (code: string) => run(A.verifyOtpAction({}, fd({ code })));
const wrongCode = (real: string) => (real === "000000" ? "111111" : "000000");

/** Complete a full sign-in (password + emailed code) and return the active session cookie. */
async function signIn(email = "alice@example.com", password = GOOD) {
  await login(email, password);
  const r = await verify(lastCode());
  expect(r.redirect).toBe("/dashboard");
  return h.store.get(COOKIE)!;
}

const activeSessions = (userId: string) => M.Session.countDocuments({ userId, stage: "active" });

/* ================================ LOGIN + OTP ================================ */

describe("login with email + password, then emailed OTP", () => {
  it("a correct password only creates an OTP-stage session — no app access until the code is verified", async () => {
    const u = await makeUser();
    const r = await login("alice@example.com", GOOD);
    expect(r.redirect).toBe("/verify-otp");
    const s = await M.Session.findOne({ userId: u._id }).lean();
    expect(s?.stage).toBe("otp");
    expect(await sessionMod.getSessionUser()).toBeNull(); // cannot use the app yet
    expect(await sessionMod.getPendingOtpSession()).not.toBeNull();
    expect(mail.devOutbox).toHaveLength(1);
    expect(mail.devOutbox[0].to).toBe("alice@example.com");
    expect(mail.devOutbox[0].text).toMatch(/\b\d{6}\b/);
    expect(mail.devOutbox[0].html).toContain(lastCode()); // the branded HTML carries the same code
  });

  it("the session cookie is httpOnly + SameSite=Lax, random, and only its hash is stored", async () => {
    const u = await makeUser();
    await login("alice@example.com", GOOD);
    const token = h.store.get(COOKIE)!;
    const o = h.opts.get(COOKIE)!;
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe("lax");
    expect(o.path).toBe("/");
    expect(token.length).toBeGreaterThanOrEqual(40);
    const row = await M.Session.findOne({ userId: u._id }).lean();
    expect(row!.tokenHash).not.toContain(token);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a correct code signs in: a NEW active session is issued (token rotated), limited to 12h absolute / 30 min idle", async () => {
    const u = await makeUser();
    await login("alice@example.com", GOOD);
    const otpToken = h.store.get(COOKIE)!;
    const r = await verify(lastCode());
    expect(r.redirect).toBe("/dashboard");
    const activeToken = h.store.get(COOKIE)!;
    expect(activeToken).not.toBe(otpToken); // no session fixation
    const user = await sessionMod.getSessionUser();
    expect(user?.id).toBe(String(u._id));
    const row = await M.Session.findOne({ userId: u._id, stage: "active" }).lean();
    const now = Date.now();
    expect(Math.abs(row!.expiresAt.getTime() - (now + 12 * 3600_000))).toBeLessThan(60_000);
    expect(Math.abs(row!.idleExpiresAt.getTime() - (now + 30 * 60_000))).toBeLessThan(60_000);
    expect(await M.Session.countDocuments({ userId: u._id, stage: "otp" })).toBe(0); // the OTP-stage row is gone
    expect((await M.User.findById(u._id).lean())!.lastLoginAt).toBeInstanceOf(Date);
  });

  it("a wrong code is rejected and grants nothing", async () => {
    await makeUser();
    await login("alice@example.com", GOOD);
    const r = await verify(wrongCode(lastCode()));
    expect(r.redirect).toBeNull();
    expect(r.result?.error).toMatch(/Incorrect code/);
    expect(await sessionMod.getSessionUser()).toBeNull();
  });

  it("malformed codes are rejected before touching the database", async () => {
    await makeUser();
    await login("alice@example.com", GOOD);
    for (const bad of ["", "12345", "1234567", "abcdef", "12 345"]) {
      const r = await verify(bad);
      expect(r.result?.error).toBeTruthy();
    }
    expect(await sessionMod.getSessionUser()).toBeNull();
  });

  it("an EXPIRED code is rejected even when it is correct", async () => {
    const u = await makeUser();
    await login("alice@example.com", GOOD);
    const code = lastCode();
    await M.Otp.updateMany({ userId: u._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await verify(code);
    expect(r.redirect).toBeNull();
    expect(r.result?.error).toMatch(/invalid or has expired/);
    expect(await sessionMod.getSessionUser()).toBeNull();
  });

  it("a code is valid for ~10 minutes", async () => {
    const u = await makeUser();
    await login("alice@example.com", GOOD);
    const ch = await M.Otp.findOne({ userId: u._id }).lean();
    const ttl = ch!.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    expect(ch!.codeHash).toMatch(/^[0-9a-f]{64}$/); // only an HMAC of the code is stored
  });

  it("a code can NOT be reused", async () => {
    await makeUser();
    await login("alice@example.com", GOOD);
    const code = lastCode();
    expect((await verify(code)).redirect).toBe("/dashboard");
    // sign in again in a fresh browser and try to replay the already-used code
    h.store.clear();
    mail.devOutbox.length = 0;
    await login("alice@example.com", GOOD);
    const replay = await verify(code);
    expect(replay.redirect).toBeNull();
    expect(replay.result?.error).toBeTruthy();
    expect(await sessionMod.getSessionUser()).toBeNull();
  });

  it("five wrong guesses burn the code: even the correct code is then refused", async () => {
    await makeUser();
    await login("alice@example.com", GOOD);
    const code = lastCode();
    for (let i = 0; i < 5; i++) await verify(wrongCode(code));
    const r = await verify(code);
    expect(r.redirect).toBeNull();
    expect(r.result?.error).toMatch(/Too many incorrect codes/);
  });

  it("parallel guesses cannot exceed the attempt limit", async () => {
    const u = await makeUser();
    await login("alice@example.com", GOOD);
    const code = lastCode();
    await Promise.all(Array.from({ length: 12 }, () => verify(wrongCode(code))));
    const ch = await M.Otp.findOne({ userId: u._id }).lean();
    expect(ch!.attempts).toBeLessThanOrEqual(5);
  });

  it("the same code cannot be redeemed twice in parallel (single use is atomic)", async () => {
    await makeUser();
    await login("alice@example.com", GOOD);
    const code = lastCode();
    const results = await Promise.all([verify(code), verify(code), verify(code)]);
    expect(results.filter((r) => r.redirect === "/dashboard")).toHaveLength(1);
  });

  it("resend: a new code is emailed and the OLD one stops working", async () => {
    await makeUser();
    await login("alice@example.com", GOOD);
    const first = lastCode();
    const r = await A.resendOtpAction();
    expect(r.message).toMatch(/new code/i);
    expect(mail.devOutbox).toHaveLength(2);
    const second = lastCode();
    expect(second).not.toBe(first);
    expect((await verify(first)).redirect).toBeNull(); // old code is dead
    expect((await verify(second)).redirect).toBe("/dashboard");
  });

  it("resend is rate limited: 30-second cooldown, then at most 3 per 10 minutes", async () => {
    await makeUser();
    await login("alice@example.com", GOOD);
    expect((await A.resendOtpAction()).message).toBeTruthy();
    const tooSoon = await A.resendOtpAction();
    expect(tooSoon.error).toMatch(/wait \d+ seconds/);
    const RateLimit = (await import("@/lib/db/models/misc")).RateLimit;
    const sent = [1];
    for (let i = 0; i < 4; i++) {
      await RateLimit.deleteMany({ _id: /^otp-resend-cd:/ }); // simulate the 30 s cooldown elapsing
      const r = await A.resendOtpAction();
      if (r.message) sent.push(1);
    }
    expect(sent.length).toBe(3); // the 4th+ were refused by the 10-minute cap
    await RateLimit.deleteMany({ _id: /^otp-resend-cd:/ });
    expect((await A.resendOtpAction()).error).toMatch(/Too many resend/);
  });

  it("a code only works for the sign-in attempt that requested it", async () => {
    await makeUser();
    await login("alice@example.com", GOOD);
    const tokenA = h.store.get(COOKIE)!;
    h.store.clear();
    await login("alice@example.com", GOOD); // second browser
    const tokenB = h.store.get(COOKIE)!;
    const codeB = lastCode();
    h.store.set(COOKIE, tokenA); // back to browser A with B's code
    expect((await verify(codeB)).redirect).toBeNull();
    h.store.set(COOKIE, tokenB);
    expect((await verify(codeB)).redirect).toBe("/dashboard");
  });

  it("verifying with no pending sign-in sends you back to /login", async () => {
    expect((await verify("123456")).redirect).toBe("/login");
  });

  it("an OTP-stage session expires after ~10 minutes", async () => {
    const u = await makeUser();
    await login("alice@example.com", GOOD);
    const code = lastCode();
    await M.Session.updateMany({ userId: u._id }, { $set: { expiresAt: new Date(Date.now() - 1000), idleExpiresAt: new Date(Date.now() - 1000) } });
    expect((await verify(code)).redirect).toBe("/login");
  });

  it("if the email cannot be sent, sign-in fails cleanly and leaves no session behind", async () => {
    const u = await makeUser();
    const spy = vi.spyOn(mail, "sendMail").mockRejectedValueOnce(new mail.MailError("auth", "Gmail rejected the login"));
    const r = await login("alice@example.com", GOOD);
    spy.mockRestore();
    expect(r.redirect).toBeNull();
    expect(r.result?.error).toMatch(/could not send the verification email/i);
    expect(await M.Session.countDocuments({ userId: u._id })).toBe(0);
  });
});

/* ================================ ACCOUNT SECURITY ================================ */

describe("account security: generic errors, lockout, rate limiting", () => {
  it("wrong password and unknown email return the IDENTICAL message (no account enumeration)", async () => {
    await makeUser();
    const wrong = await login("alice@example.com", "nope-nope");
    const unknown = await login("nobody@example.com", "nope-nope");
    expect(wrong.result?.error).toBe(lockout.LOGIN_FAILED_MESSAGE);
    expect(unknown.result?.error).toBe(lockout.LOGIN_FAILED_MESSAGE);
    expect(await M.Session.countDocuments()).toBe(0);
  });

  it("five wrong passwords lock the account for 15 minutes", async () => {
    const u = await makeUser();
    for (let i = 0; i < 5; i++) await login("alice@example.com", "wrong-" + i);
    const row = await M.User.findById(u._id).lean();
    expect(row!.failedLogins).toBe(5);
    expect(row!.lockedUntil).toBeInstanceOf(Date);
    const mins = (row!.lockedUntil!.getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(14);
    expect(mins).toBeLessThanOrEqual(15);
  });

  it("a locked account refuses even the CORRECT password, shows the same generic message, and the lock is not extended", async () => {
    const u = await makeUser();
    for (let i = 0; i < 5; i++) await login("alice@example.com", "wrong-" + i);
    const before = (await M.User.findById(u._id).lean())!.lockedUntil!.getTime();
    const r = await login("alice@example.com", GOOD);
    expect(r.redirect).toBeNull();
    expect(r.result?.error).toBe(lockout.LOGIN_FAILED_MESSAGE); // indistinguishable from a wrong password
    expect(await M.Session.countDocuments()).toBe(0);
    expect(mail.devOutbox).toHaveLength(0); // no code is sent to a locked account
    expect((await M.User.findById(u._id).lean())!.lockedUntil!.getTime()).toBe(before);
  });

  it("the lock expires after 15 minutes, the correct password works again, and the counter is cleared", async () => {
    const u = await makeUser();
    for (let i = 0; i < 5; i++) await login("alice@example.com", "wrong-" + i);
    await M.User.updateOne({ _id: u._id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
    const r = await login("alice@example.com", GOOD);
    expect(r.redirect).toBe("/verify-otp");
    const row = await M.User.findById(u._id).lean();
    expect(row!.failedLogins).toBe(0);
    expect(row!.lockedUntil).toBeNull();
  });

  it("after a lock expires, ONE typo does not instantly re-lock (counting restarts at 1)", async () => {
    const u = await makeUser();
    for (let i = 0; i < 5; i++) await login("alice@example.com", "wrong-" + i);
    await M.User.updateOne({ _id: u._id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
    await login("alice@example.com", "typo");
    const row = await M.User.findById(u._id).lean();
    expect(row!.failedLogins).toBe(1);
    expect(row!.lockedUntil).toBeNull();
  });

  it("the failed-attempt counter is atomic: parallel wrong guesses lock at exactly 5 and never undercount", async () => {
    const u = await makeUser();
    await Promise.all(Array.from({ length: 8 }, (_, i) => login("alice@example.com", "wrong-" + i)));
    const row = await M.User.findById(u._id).lean();
    expect(row!.failedLogins).toBe(5);
    expect(row!.lockedUntil).toBeInstanceOf(Date);
  });

  it("a successful sign-in resets the failed-attempt counter", async () => {
    const u = await makeUser();
    for (let i = 0; i < 3; i++) await login("alice@example.com", "wrong-" + i);
    expect((await M.User.findById(u._id).lean())!.failedLogins).toBe(3);
    await login("alice@example.com", GOOD);
    expect((await M.User.findById(u._id).lean())!.failedLogins).toBe(0);
  });

  it("a disabled account cannot sign in and gets the same generic message", async () => {
    await makeUser("alice@example.com", "compliance_manager", GOOD, { active: false });
    const r = await login("alice@example.com", GOOD);
    expect(r.result?.error).toBe(lockout.LOGIN_FAILED_MESSAGE);
    expect(await M.Session.countDocuments()).toBe(0);
  });

  it("login attempts per email are rate limited (8 / 15 min) — same response for existing and unknown emails", async () => {
    await makeUser();
    for (let i = 0; i < 8; i++) await login("ghost@example.com", "x");
    const blockedUnknown = await login("ghost@example.com", "x");
    expect(blockedUnknown.result?.error).toMatch(/Too many sign-in attempts/);
    await M.User.updateOne({ email: "alice@example.com" }, { $set: { failedLogins: 0, lockedUntil: null } });
    const RateLimit = (await import("@/lib/db/models/misc")).RateLimit;
    await RateLimit.deleteMany({ _id: /^login:ip:/ });
    for (let i = 0; i < 8; i++) await login("alice@example.com", "x");
    const blockedKnown = await login("alice@example.com", GOOD);
    expect(blockedKnown.result?.error).toBe(blockedUnknown.result?.error);
  });

  it("login attempts per IP are rate limited (20 / 15 min) across different emails", async () => {
    for (let i = 0; i < 20; i++) await login(`u${i}@example.com`, "x");
    const r = await login("u99@example.com", "x");
    expect(r.result?.error).toMatch(/Too many sign-in attempts/);
    h.hdrs.set("x-forwarded-for", "10.9.9.9"); // a different client is unaffected
    expect((await login("u100@example.com", "x")).result?.error).toBe(lockout.LOGIN_FAILED_MESSAGE);
  });

  it("the rate limiter cannot be beaten by a parallel burst (exactly `limit` requests are allowed)", async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => rateLimit("burst-test", 10, 60)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(Math.min(...results.map((r) => r.remaining))).toBe(0);
  });

  it("the rate-limit window resets after it elapses", async () => {
    for (let i = 0; i < 3; i++) await rateLimit("window-test", 2, 60);
    expect((await rateLimit("window-test", 2, 60)).allowed).toBe(false);
    const RateLimit = (await import("@/lib/db/models/misc")).RateLimit;
    await RateLimit.updateOne({ _id: "window-test" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await rateLimit("window-test", 2, 60);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
  });

  it("failed and locked attempts are audit-logged without secrets", async () => {
    const u = await makeUser();
    for (let i = 0; i < 5; i++) await login("alice@example.com", "wrong-" + i);
    const evs = await M.Audit.find({ entityId: String(u._id), action: "login_failed" }).lean();
    expect(evs.length).toBe(5);
    expect(evs.some((e) => /locked/i.test(e.summary ?? ""))).toBe(true);
    expect(JSON.stringify(evs)).not.toContain("wrong-");
  });
});

/* ================================ PASSWORD RESET ================================ */

describe("password reset by emailed code", () => {
  const request = (email: string) => A.requestPasswordResetAction({}, fd({ email }));
  const reset = (email: string, code: string, password: string) => run(A.resetPasswordAction({}, fd({ email, code, password })));

  it("responds identically for existing and unknown emails; only the real account receives a code", async () => {
    await makeUser();
    const known = await request("alice@example.com");
    const known2 = known;
    const sentToKnown = mail.devOutbox.length;
    const unknown = await request("ghost@example.com");
    expect(unknown).toEqual({ ...known2, email: "ghost@example.com" });
    expect(sentToKnown).toBe(1);
    expect(mail.devOutbox).toHaveLength(1); // nothing was sent for the unknown address
    expect(mail.devOutbox[0].to).toBe("alice@example.com");
    expect(mail.devOutbox[0].subject).toMatch(/password reset/i);
    expect(mail.devOutbox[0].text).toMatch(/\b\d{6}\b/);
  });

  it("a rate-limited request still returns the identical response (and sends nothing)", async () => {
    await makeUser();
    for (let i = 0; i < 3; i++) await request("alice@example.com");
    mail.devOutbox.length = 0;
    const limited = await request("alice@example.com");
    expect(limited.message).toMatch(/If that account exists/);
    expect(mail.devOutbox).toHaveLength(0);
  });

  it("a disabled account gets no code but the same response", async () => {
    await makeUser("alice@example.com", "compliance_manager", GOOD, { active: false });
    expect((await request("alice@example.com")).message).toMatch(/If that account exists/);
    expect(mail.devOutbox).toHaveLength(0);
  });

  it("the code must be correct: a wrong code (or an unknown email) gives the same 'Invalid or expired code.'", async () => {
    await makeUser();
    await request("alice@example.com");
    const code = lastCode();
    const wrong = await reset("alice@example.com", wrongCode(code), "Another-Str0ng-Pass!");
    const unknown = await reset("ghost@example.com", code, "Another-Str0ng-Pass!");
    expect(wrong.result?.error).toBe("Invalid or expired code.");
    expect(unknown.result?.error).toBe("Invalid or expired code.");
    expect(wrong.redirect).toBeNull();
  });

  it("success: the password changes, the code is single-use, and the lock is cleared", async () => {
    const u = await makeUser("alice@example.com", "compliance_manager", GOOD, { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) });
    await request("alice@example.com");
    const code = lastCode();
    const NEW = "Brand-New-Passw0rd!";
    const ok = await reset("alice@example.com", code, NEW);
    expect(ok.redirect).toBe("/login?reset=1");
    const row = await M.User.findById(u._id).lean();
    expect(row!.failedLogins).toBe(0);
    expect(row!.lockedUntil).toBeNull();
    // old password no longer works, new one does
    expect((await login("alice@example.com", GOOD)).result?.error).toBe(lockout.LOGIN_FAILED_MESSAGE);
    expect((await login("alice@example.com", NEW)).redirect).toBe("/verify-otp");
    // the code cannot be used again
    const replay = await reset("alice@example.com", code, "Yet-Another-Passw0rd!");
    expect(replay.result?.error).toBe("Invalid or expired code.");
  });

  it("an EXPIRED reset code is rejected", async () => {
    const u = await makeUser();
    await request("alice@example.com");
    const code = lastCode();
    await M.Otp.updateMany({ userId: u._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await reset("alice@example.com", code, "Brand-New-Passw0rd!")).result?.error).toBe("Invalid or expired code.");
  });

  it("a newly requested code replaces the previous one", async () => {
    await makeUser();
    await request("alice@example.com");
    const first = lastCode();
    await request("alice@example.com");
    const second = lastCode();
    expect(second).not.toBe(first);
    expect((await reset("alice@example.com", first, "Brand-New-Passw0rd!")).result?.error).toBe("Invalid or expired code.");
    expect((await reset("alice@example.com", second, "Brand-New-Passw0rd!")).redirect).toBe("/login?reset=1");
  });

  it("five wrong reset codes burn the code", async () => {
    await makeUser();
    await request("alice@example.com");
    const code = lastCode();
    for (let i = 0; i < 5; i++) await reset("alice@example.com", wrongCode(code), "Brand-New-Passw0rd!");
    expect((await reset("alice@example.com", code, "Brand-New-Passw0rd!")).result?.error).toBe("Invalid or expired code.");
  });

  it("ALL existing sessions are invalidated after a successful reset", async () => {
    const u = await makeUser();
    await signIn(); // a real active session on "device 1"
    await M.Session.create({ userId: String(u._id), tokenHash: "f".repeat(64), stage: "active", expiresAt: new Date(Date.now() + 3600_000), idleExpiresAt: new Date(Date.now() + 1800_000) }); // "device 2"
    expect(await activeSessions(String(u._id))).toBe(2);
    h.store.clear();
    await request("alice@example.com");
    expect((await reset("alice@example.com", lastCode(), "Brand-New-Passw0rd!")).redirect).toBe("/login?reset=1");
    expect(await M.Session.countDocuments({ userId: String(u._id) })).toBe(0);
  });

  it("the password policy is enforced for regular users — WITHOUT burning the code or leaking which emails exist", async () => {
    await makeUser();
    await request("alice@example.com");
    const code = lastCode();
    const weak = await reset("alice@example.com", code, "short");
    expect(weak.result?.error).toMatch(/Password must include/);
    // the code is still usable
    expect((await reset("alice@example.com", code, "Brand-New-Passw0rd!")).redirect).toBe("/login?reset=1");
    // unknown email + weak password must NOT reveal a policy message (it would reveal the account does not exist)
    const ghost = await reset("ghost@example.com", "123456", "short");
    expect(ghost.result?.error).toBe("Invalid or expired code.");
    // and a real account with a WRONG code + weak password also gets the generic message
    await makeUser("bob@example.com");
    await request("bob@example.com");
    const wrongWeak = await reset("bob@example.com", wrongCode(lastCode()), "short");
    expect(wrongWeak.result?.error).toBe("Invalid or expired code.");
  });

  it("the Super Admin may choose ANY password", async () => {
    await makeUser("root@example.com", "super_admin");
    await request("root@example.com");
    expect((await reset("root@example.com", lastCode(), "a")).redirect).toBe("/login?reset=1");
    expect((await login("root@example.com", "a")).redirect).toBe("/verify-otp");
  });

  it("an empty new password is refused", async () => {
    await makeUser("root@example.com", "super_admin");
    await request("root@example.com");
    expect((await reset("root@example.com", lastCode(), "")).result?.error).toMatch(/Enter a new password/);
  });

  it("the reset is audit-logged", async () => {
    const u = await makeUser();
    await request("alice@example.com");
    await reset("alice@example.com", lastCode(), "Brand-New-Passw0rd!");
    expect(await M.Audit.countDocuments({ entityId: String(u._id), action: "password_change" })).toBe(1);
  });
});

/* ================================ CHANGE PASSWORD ================================ */

describe("changing your own password", () => {
  const change = (current: string, password: string) => run(A.changePasswordAction({}, fd({ current, password })));

  it("signs out OTHER devices but keeps this one", async () => {
    const u = await makeUser();
    const mine = await signIn();
    await M.Session.create({ userId: String(u._id), tokenHash: "e".repeat(64), stage: "active", expiresAt: new Date(Date.now() + 3600_000), idleExpiresAt: new Date(Date.now() + 1800_000) });
    expect((await change(GOOD, "Brand-New-Passw0rd!")).redirect).toBe("/dashboard");
    expect(await activeSessions(String(u._id))).toBe(1);
    expect(h.store.get(COOKIE)).toBe(mine);
    expect(await sessionMod.getSessionUser()).not.toBeNull();
  });

  it("requires the correct current password and enforces the policy for regular users", async () => {
    await makeUser();
    await signIn();
    expect((await change("wrong", "Brand-New-Passw0rd!")).result?.error).toMatch(/Current password is incorrect/);
    expect((await change(GOOD, "short")).result?.error).toMatch(/Password must include/);
    expect((await change(GOOD, GOOD)).result?.error).toMatch(/different/);
  });

  it("the Super Admin may change to any password", async () => {
    await makeUser("root@example.com", "super_admin");
    await signIn("root@example.com");
    expect((await change(GOOD, "x")).redirect).toBe("/dashboard");
  });
});

/* ================================ SESSIONS ================================ */

describe("session management", () => {
  it("an ABSOLUTE session lifetime of 12 hours is enforced", async () => {
    const u = await makeUser();
    await signIn();
    await M.Session.updateOne({ userId: String(u._id), stage: "active" }, { $set: { expiresAt: new Date(Date.now() - 1000), idleExpiresAt: new Date(Date.now() + 1800_000) } });
    expect(await sessionMod.getSessionUser()).toBeNull(); // idle time is irrelevant once the 12 h are over
  });

  it("the 30-minute IDLE timeout is enforced", async () => {
    const u = await makeUser();
    await signIn();
    await M.Session.updateOne({ userId: String(u._id), stage: "active" }, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
    expect(await sessionMod.getSessionUser()).toBeNull();
  });

  it("activity extends the idle window (sliding), but never past the absolute limit", async () => {
    const u = await makeUser();
    await signIn();
    await M.Session.updateOne({ userId: String(u._id), stage: "active" }, { $set: { idleExpiresAt: new Date(Date.now() + 5 * 60_000) } });
    expect(await sessionMod.getSessionUser()).not.toBeNull();
    const row = await M.Session.findOne({ userId: String(u._id), stage: "active" }).lean();
    expect(row!.idleExpiresAt.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);
    // near the absolute end, the session still dies at the absolute time regardless of the renewed idle window
    await M.Session.updateOne({ _id: row!._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    expect(await sessionMod.getSessionUser()).toBeNull();
  });

  it("logout deletes the session, clears the cookie, and the old cookie cannot be replayed", async () => {
    const u = await makeUser();
    const token = await signIn();
    const out = await run(A.logoutAction());
    expect(out.redirect).toBe("/login");
    expect(h.store.has(COOKIE)).toBe(false);
    expect(await activeSessions(String(u._id))).toBe(0);
    h.store.set(COOKIE, token); // an attacker replays the stolen cookie
    expect(await sessionMod.getSessionUser()).toBeNull();
    expect(await M.Audit.countDocuments({ entityId: String(u._id), action: "logout" })).toBe(1);
  });

  it("a forged, truncated or empty cookie never authenticates", async () => {
    await makeUser();
    await signIn();
    for (const bad of ["garbage", "", "a".repeat(43), "../../etc/passwd"]) {
      h.store.set(COOKIE, bad);
      expect(await sessionMod.getSessionUser()).toBeNull();
    }
  });

  it("a session stops working the moment the user is disabled or deleted", async () => {
    const u = await makeUser();
    await signIn();
    await M.User.updateOne({ _id: u._id }, { $set: { active: false } });
    expect(await sessionMod.getSessionUser()).toBeNull();
    await M.User.updateOne({ _id: u._id }, { $set: { active: true } });
    expect(await sessionMod.getSessionUser()).not.toBeNull();
    await M.User.deleteOne({ _id: u._id });
    expect(await sessionMod.getSessionUser()).toBeNull();
  });

  it("role changes take effect immediately (permissions are read fresh on every request)", async () => {
    const u = await makeUser("alice@example.com", "auditor");
    await signIn();
    expect((await sessionMod.getSessionUser())!.role).toBe("auditor");
    await M.User.updateOne({ _id: u._id }, { $set: { role: "compliance_manager" } });
    expect((await sessionMod.getSessionUser())!.role).toBe("compliance_manager");
  });

  it("deleting all of a user's sessions signs every device out", async () => {
    const u = await makeUser();
    await signIn();
    await sessionMod.destroyAllSessionsFor(String(u._id));
    expect(await sessionMod.getSessionUser()).toBeNull();
  });
});

/* ================================ UNAUTHORIZED API ACCESS ================================ */

describe("protected API routes and the proxy gate", () => {
  const { NextRequest } = require("next/server") as typeof import("next/server");
  const req = (path: string) => new NextRequest(`http://localhost${path}`);

  async function callTasks() {
    const { GET } = await import("@/app/api/tasks/route");
    return GET(req("/api/tasks") as never) as Promise<Response>;
  }
  async function callCandidates() {
    const { GET } = await import("@/app/api/candidates/route");
    return GET(req("/api/candidates") as never) as Promise<Response>;
  }

  it("no cookie → 401 on a protected route", async () => {
    expect((await callTasks()).status).toBe(401);
    expect((await callCandidates()).status).toBe(401);
  });

  it("garbage cookie → 401", async () => {
    h.store.set(COOKIE, "not-a-real-session");
    expect((await callTasks()).status).toBe(401);
  });

  it("an OTP-stage cookie (password only, code not yet entered) → 401", async () => {
    await makeUser();
    await login("alice@example.com", GOOD);
    expect((await callTasks()).status).toBe(401);
    expect((await callCandidates()).status).toBe(401);
  });

  it("a valid fully-authenticated session is accepted", async () => {
    await makeUser();
    await signIn();
    expect((await callTasks()).status).toBe(200);
    expect((await callCandidates()).status).toBe(200);
  });

  it("an EXPIRED session → 401 (absolute limit)", async () => {
    const u = await makeUser();
    await signIn();
    await M.Session.updateOne({ userId: String(u._id), stage: "active" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await callTasks()).status).toBe(401);
  });

  it("an IDLE-timed-out session → 401", async () => {
    const u = await makeUser();
    await signIn();
    await M.Session.updateOne({ userId: String(u._id), stage: "active" }, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
    expect((await callTasks()).status).toBe(401);
  });

  it("a logged-out cookie → 401", async () => {
    await makeUser();
    const token = await signIn();
    await run(A.logoutAction());
    h.store.set(COOKIE, token);
    expect((await callTasks()).status).toBe(401);
  });

  it("routes that use requireAction() (CSV export) also answer 401 — not 403 — when the session is gone", async () => {
    const { GET } = await import("@/app/api/candidates/export/route");
    const res = await GET(req("/api/candidates/export") as never);
    expect(res.status).toBe(401);
  });

  it("a logged-in user without the permission gets 403 (not 401)", async () => {
    await makeUser("aud@example.com", "auditor"); // auditors cannot export candidates
    await signIn("aud@example.com");
    const { GET } = await import("@/app/api/candidates/export/route");
    expect((await GET(req("/api/candidates/export") as never)).status).toBe(403);
  });

  it("the proxy gate: no cookie → 401 JSON for /api and a redirect to /login for pages; public pages stay open", async () => {
    const { proxy } = await import("@/proxy");
    const api = proxy(req("/api/tasks"));
    expect(api.status).toBe(401);
    const page = proxy(req("/dashboard"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/login");
    for (const open of ["/login", "/verify-otp", "/forgot-password"]) expect(proxy(req(open)).status).toBe(200);
    const withCookie = new NextRequest("http://localhost/dashboard", { headers: { cookie: `${COOKIE}=abc` } });
    expect(proxy(withCookie).status).toBe(200); // the real validity check happens server-side
  });
});
