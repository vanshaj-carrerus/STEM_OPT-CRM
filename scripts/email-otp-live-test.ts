/**
 * LIVE email test through the real OTP code path (issueOtp → sendMail → Gmail).
 *
 * Sends exactly ONE real sign-in-code email, to the account in EMAIL_USER itself (the sender's own mailbox), using a
 * throw-away user in a scratch database that is dropped afterwards. Nothing is written to the real database.
 * Success is reported only if Gmail actually accepted the message; any failure is printed as-is.
 *
 *   npm run email:live-otp
 */
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch {}

async function main() {
  const to = (process.env.EMAIL_USER ?? "").trim().replace(/^["']|["']$/g, "");
  if (!to) {
    console.log("EMAIL_USER is not set — nothing to test.");
    process.exit(2);
  }
  const scratch = `dbtest_live_${Date.now().toString(36)}`;
  process.env.MONGODB_DB = scratch; // never the real database

  const { connectDb } = await import("../src/lib/db/connect");
  const mongoose = await connectDb();
  if (!mongoose.connection.name.startsWith("dbtest_")) throw new Error("Safety stop: not a scratch database");
  const { isMailConfigured, devOutbox } = await import("../src/lib/mail");
  const { issueOtp } = await import("../src/lib/auth/otp");
  const { User } = await import("../src/lib/db/models/user");
  const { OtpChallenge } = await import("../src/lib/db/models/otp");

  let exit = 0;
  try {
    if (!isMailConfigured()) {
      console.log("Email is NOT configured (EMAIL_USER / EMAIL_PASS) — the OTP would only be printed to the console.");
      exit = 2;
    } else {
      const user = await User.create({ name: "OTP Live Test", email: to, role: "auditor", passwordHash: "x" });
      console.log(`Sending one real sign-in code email to ${to.slice(0, 2)}***@${to.split("@")[1]} through Gmail…`);
      await issueOtp({ _id: String(user._id), email: to, name: user.name }, "login", "live-test-session");
      const challenge = await OtpChallenge.findOne({ userId: String(user._id) }).lean();
      const printedToConsole = devOutbox.length > 0;
      if (printedToConsole) {
        console.log("✗ The message was only printed to the console (no real send happened).");
        exit = 1;
      } else {
        console.log("✓ Gmail ACCEPTED the sign-in code email for delivery (no error was thrown).");
        console.log(`  A challenge was stored: expires in ${Math.round(((challenge!.expiresAt.getTime() - Date.now()) / 60_000) * 10) / 10} min, only its HMAC is saved.`);
        console.log("  Check the inbox of that address (and spam) for 'Your Compliance CRM sign-in code'.");
      }
    }
  } catch (e) {
    const m = (e as Error).message;
    console.log(`✗ SEND FAILED: ${m}`);
    exit = 1;
  } finally {
    await mongoose.connection.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
    console.log(`(scratch database ${scratch} dropped)`);
  }
  process.exit(exit);
}

main().catch((e) => {
  console.error("crashed:", (e as Error).message);
  process.exit(1);
});
