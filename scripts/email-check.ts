/**
 * Email diagnostic — tells you EXACTLY whether the app can send mail, and why not if it can't.
 *
 *   npm run email:check                     → loads .env.local, logs in to Gmail (SMTP auth only, nothing is sent)
 *   npm run email:check -- --send-to=me@x.y → additionally sends one real test email to that address
 *
 * Credentials are never printed. A failure is reported as-is; success is only reported when Gmail actually accepted
 * the login (and, with --send-to, accepted the message).
 */
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch {}

const sendTo = process.argv.find((a) => a.startsWith("--send-to="))?.split("=")[1];

function explain(code: string | undefined, responseCode: number | undefined, message: string): string[] {
  const m = message.toLowerCase();
  if (responseCode === 535 || /username and password not accepted|badcredentials|invalid login/.test(m)) {
    return [
      "Google rejected the username/password (535 BadCredentials). This is NOT a code problem. Check, in this order:",
      "  1. EMAIL_USER is the exact Google account the app password was created under (watch for typos in the domain).",
      "  2. EMAIL_PASS is a Google APP PASSWORD (16 letters), not the normal account password.",
      "     Create one at https://myaccount.google.com/apppasswords while signed in as EMAIL_USER (2-Step Verification must be ON).",
      "  3. If the address is a Google Workspace account, the Workspace admin must allow app passwords",
      "     (Admin console → Security → Authentication → 2-Step Verification / Less secure apps / App passwords).",
      "  4. If you changed the password or the app password was revoked, generate a new one.",
    ];
  }
  if (code === "EDNS" || code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNECTION") {
    return ["Could not reach smtp.gmail.com (network). Check internet / firewall / VPN; outbound ports 465 and 587 must be open."];
  }
  if (responseCode === 534 || /application-specific password required/.test(m)) {
    return ["Google requires an app-specific password for this account: turn on 2-Step Verification and create an app password."];
  }
  return [`Unclassified error (${code ?? responseCode ?? "no code"}).`];
}

async function main() {
  const user = (process.env.EMAIL_USER ?? "").trim().replace(/^["']|["']$/g, "");
  const rawPass = process.env.EMAIL_PASS ?? process.env.EMAIL_PASSWORD ?? "";
  const pass = rawPass.replace(/[\s"']/g, "");

  console.log("Email configuration");
  console.log(`  EMAIL_USER      : ${user ? `${user.slice(0, 2)}***@${user.split("@")[1] ?? "(no @)"}` : "NOT SET"}`);
  console.log(`  EMAIL_PASS      : ${pass ? `set (${pass.length} characters after removing spaces)` : "NOT SET"}`);
  if (!user || !pass) {
    console.log("\nNOT CONFIGURED: set EMAIL_USER and EMAIL_PASS in .env.local. Until then, OTP codes are printed to the server console (development only).");
    process.exit(2);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user)) {
    console.log("\nEMAIL_USER is not a valid email address.");
    process.exit(1);
  }
  if (pass.length !== 16) console.log(`  note: a Google app password is exactly 16 letters; yours has ${pass.length}.`);

  const nodemailer = (await import("nodemailer")).default;
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  console.log("\nConnecting to smtp.gmail.com and authenticating…");
  try {
    await transporter.verify();
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; message: string };
    console.log(`\n✗ LOGIN FAILED: ${err.message.split("\n")[0]}`);
    for (const line of explain(err.code, err.responseCode, err.message)) console.log(line);
    process.exit(1);
  }
  console.log("✓ Gmail accepted the login. The app can send email.");

  if (sendTo) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sendTo)) {
      console.log("--send-to is not a valid address");
      process.exit(1);
    }
    try {
      const info = await transporter.sendMail({
        from: `CUS Tech <${user}>`,
        to: sendTo,
        subject: "Compliance CRM — email delivery test",
        text: "This is a test message from the Compliance CRM email check. If you can read this, OTP and reminder emails will work.",
      });
      console.log(`✓ Test email accepted by Gmail for delivery to ${sendTo} (message id ${info.messageId}).`);
      console.log("  Check the inbox (and spam) to confirm it arrived.");
    } catch (e) {
      console.log(`✗ SEND FAILED: ${(e as Error).message.split("\n")[0]}`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error("email-check crashed:", (e as Error).message);
  process.exit(1);
});
