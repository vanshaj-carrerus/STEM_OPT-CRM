import { beforeEach, describe, expect, it, vi } from "vitest";

const PASS = "abcdefghijklmnop";
const sendMailMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  sendMailMock.mockReset();
  process.env.EMAIL_USER = "sender@example.com";
  process.env.EMAIL_PASS = "abcd efgh ijkl mnop"; // Google displays app passwords with spaces
  delete process.env.EMAIL_PASSWORD;
  (process.env as Record<string, string>).NODE_ENV = "test";
  vi.resetModules();
});

/** Loads a fresh copy of the mail module wired to the fake transport (no real network access is possible). */
const load = async () => {
  const m = await import("@/lib/mail");
  m.setMailTransport({ sendMail: sendMailMock } as never);
  return m;
};
const input = { to: "user@example.com", subject: "Code", text: "Your code is 123456" };

describe("mail delivery", () => {
  it("sends through Gmail with the spaces stripped from the app password and reports success only after acceptance", async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: "x" });
    const { sendMail } = await load();
    const r = await sendMail(input);
    expect(r).toEqual({ delivered: true, mode: "gmail" });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].from).toContain("sender@example.com");
  });

  it("accepts EMAIL_PASSWORD as an alias, and EMAIL_PASS wins when both are set", async () => {
    delete process.env.EMAIL_PASS;
    process.env.EMAIL_PASSWORD = PASS;
    let m = await load();
    expect(m.isMailConfigured()).toBe(true);
    vi.resetModules();
    process.env.EMAIL_PASS = "zzzz zzzz zzzz zzzz";
    m = await load();
    expect(m.isMailConfigured()).toBe(true);
  });

  it("an authentication failure is NEVER retried (repeated bad logins can throttle the Google account)", async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { responseCode: 535, code: "EAUTH" }));
    const { sendMail, MailError } = await load();
    const err = await sendMail(input).catch((e) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err.kind).toBe("auth");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("a transient NETWORK error (slow DNS) is retried once and can then succeed", async () => {
    sendMailMock.mockRejectedValueOnce(Object.assign(new Error("DNS lookup for smtp.gmail.com timed out"), { code: "EDNS" })).mockResolvedValueOnce({ messageId: "y" });
    const { sendMail } = await load();
    const r = await sendMail(input);
    expect(r.delivered).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("a persistent network error fails after ONE retry — it never pretends to have delivered", async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
    const { sendMail } = await load();
    const err = await sendMail(input).catch((e) => e);
    expect(err.kind).toBe("network");
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("error messages never contain the password or the account name", async () => {
    sendMailMock.mockRejectedValue(new Error(`Auth failed for sender@example.com with ${PASS}`));
    const { sendMail } = await load();
    const err = await sendMail(input).catch((e) => e);
    expect(err.message).not.toContain(PASS);
    expect(err.message).not.toContain("sender@example.com");
    expect(err.message).toContain("[redacted]");
  });

  it("not configured: development prints to the console (and says so); production REFUSES to send", async () => {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let m = await load();
    expect(m.isMailConfigured()).toBe(false);
    expect(await m.sendMail(input)).toEqual({ delivered: true, mode: "console" });
    expect(m.devOutbox.at(-1)?.to).toBe("user@example.com");
    expect(sendMailMock).not.toHaveBeenCalled();
    log.mockRestore();
    vi.resetModules();
    (process.env as Record<string, string>).NODE_ENV = "production";
    m = await load();
    await expect(m.sendMail(input)).rejects.toThrow(/not configured/);
  });

  it("MAIL_MODE=console never sends, even when credentials exist (development only)", async () => {
    process.env.MAIL_MODE = "console";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const m = await load();
    expect(m.isMailConfigured()).toBe(false);
    expect((await m.sendMail(input)).mode).toBe("console");
    expect(sendMailMock).not.toHaveBeenCalled();
    log.mockRestore();
    delete process.env.MAIL_MODE;
  });

  it("the HTML code email escapes user-controlled text", async () => {
    const { codeEmailHtml } = await load();
    const html = codeEmailHtml({ title: "T", name: "<script>alert(1)</script>", code: "123456", minutes: 10 });
    expect(html).not.toContain("<script>");
    expect(html).toContain("123456");
  });
});
