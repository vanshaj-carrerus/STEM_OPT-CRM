import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Why a send failed, with a message that is safe to log and never contains credentials. */
export class MailError extends Error {
  constructor(
    public kind: "auth" | "network" | "config" | "other",
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "MailError";
  }
}

type Sender = Pick<Transporter, "sendMail">;
let transporter: Sender | null = null;

/** Test seam: inject a fake transport so unit tests can never contact a real mail server. Pass null to reset. */
export function setMailTransport(t: Sender | null) {
  transporter = t;
}

/** The Gmail app password, with the spaces Google displays ("abcd efgh ijkl mnop") and any quotes removed. */
function credentials(): { user: string; pass: string } | null {
  const e = env();
  if (e.MAIL_MODE === "console" && process.env.NODE_ENV !== "production") return null; // explicit "never send" switch
  const user = e.EMAIL_USER?.trim();
  const pass = (e.EMAIL_PASS ?? e.EMAIL_PASSWORD)?.replace(/[\s"']/g, "");
  return user && pass ? { user, pass } : null;
}

export function isMailConfigured(): boolean {
  return credentials() !== null;
}

/** Gmail transport using only EMAIL_USER + EMAIL_PASS (a Gmail app password). */
function getTransporter(): Sender | null {
  const c = credentials();
  if (!c) return null;
  transporter ??= nodemailer.createTransport({
    service: "gmail",
    auth: { user: c.user, pass: c.pass },
    // fail fast instead of hanging a sign-in request when the network or DNS is slow
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
  return transporter;
}

/** Classify an SMTP/network error and strip anything that could contain the credentials before it is logged. */
export function toMailError(err: unknown): MailError {
  const e = err as { code?: string; responseCode?: number; message?: string };
  let msg = String(e?.message ?? "unknown error").split("\n")[0];
  const c = credentials();
  for (const secret of [c?.pass, c?.user]) if (secret) msg = msg.split(secret).join("[redacted]");
  msg = msg.slice(0, 200);
  if (e?.responseCode === 535 || e?.responseCode === 534 || /invalid login|username and password not accepted|badcredentials/i.test(msg)) {
    return new MailError("auth", `Gmail rejected the login (${msg}). Check EMAIL_USER and the Google app password.`, e?.code);
  }
  if (["EDNS", "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "ECONNECTION", "ECONNRESET", "EAI_AGAIN"].includes(e?.code ?? "")) {
    return new MailError("network", `Could not reach the mail server (${e?.code}: ${msg}).`, e?.code);
  }
  return new MailError("other", msg, e?.code);
}

/** In-memory outbox used by tests and the dev console fallback. */
export const devOutbox: MailInput[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send an email.
 *  - Configured: sends through Gmail. Transient NETWORK errors are retried once; authentication failures are never
 *    retried (repeated bad logins can get the Google account throttled). Failures throw a MailError — success is only
 *    ever reported when Gmail accepted the message.
 *  - Not configured: development prints the message to the server console; production refuses to send.
 */
export async function sendMail(input: MailInput): Promise<{ delivered: boolean; mode: "gmail" | "console" }> {
  const t = getTransporter();
  const c = credentials();
  if (!t || !c) {
    if (process.env.NODE_ENV === "production") {
      throw new MailError("config", "Email is not configured; set EMAIL_USER and EMAIL_PASS (refusing to send in production without them).");
    }
    devOutbox.push(input);
    if (devOutbox.length > 50) devOutbox.shift();
    console.log(`\n[mail:dev] To: ${input.to}\n[mail:dev] Subject: ${input.subject}\n${input.text}\n`);
    return { delivered: true, mode: "console" };
  }
  const message = { from: `CUS Tech <${c.user}>`, ...input };
  try {
    await t.sendMail(message);
  } catch (first) {
    const mapped = toMailError(first);
    if (mapped.kind !== "network") throw mapped;
    await sleep(1500);
    try {
      await t.sendMail(message);
    } catch (second) {
      throw toMailError(second);
    }
  }
  return { delivered: true, mode: "gmail" };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Branded verification-code email (inline styles for email-client compatibility). */
export function codeEmailHtml(p: { title: string; name: string; code: string; minutes: number }) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(p.title)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#333333;">
<table role="presentation" style="border-collapse:collapse;width:100%;max-width:600px;margin:20px auto;background:#ffffff;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
<tr><td style="background:#2f4bc0;color:#ffffff;padding:20px;text-align:center;border-radius:8px 8px 0 0;"><h1 style="margin:0;font-size:20px;">${escapeHtml(p.title)}</h1></td></tr>
<tr><td style="padding:30px;text-align:center;">
<p style="margin:0 0 15px;line-height:1.5;">Hello ${escapeHtml(p.name || "User")},</p>
<p style="margin:0 0 15px;line-height:1.5;">Your verification code is:</p>
<div style="font-size:26px;font-weight:bold;letter-spacing:6px;color:#2f4bc0;margin:20px 0;padding:10px 18px;background:#eef1fb;border-radius:4px;display:inline-block;">${escapeHtml(p.code)}</div>
<p style="margin:0 0 15px;line-height:1.5;">It expires in ${p.minutes} minutes. If you did not request this, ignore this email and contact your administrator.</p>
</td></tr>
<tr><td style="padding:20px;text-align:center;font-size:12px;color:#666666;background:#f4f4f4;border-radius:0 0 8px 8px;">
<p style="margin:0 0 8px;">This is an automated message. Please do not reply directly to this email.</p>
<p style="margin:0;">&copy; ${year} CUS Tech. All rights reserved.</p></td></tr>
</table></body></html>`;
}
