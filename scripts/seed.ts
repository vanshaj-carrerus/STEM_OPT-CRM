/**
 * Creates the first Super Admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (idempotent).
 * No candidate data is ever seeded — real candidates come only from the approved master roster import.
 * Usage: npm run seed
 */
import { loadEnvFile } from "node:process";
import mongoose from "mongoose";

try {
  loadEnvFile(".env.local");
} catch {}

async function main() {
  const { env } = await import("../src/lib/env");
  const { connectDb } = await import("../src/lib/db/connect");
  const { User } = await import("../src/lib/db/models/user");
  const { hashPassword } = await import("../src/lib/auth/password");

  const e = env();
  if (!e.SEED_ADMIN_EMAIL || !e.SEED_ADMIN_PASSWORD) {
    throw new Error("Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env.local first.");
  }

  await connectDb();
  const email = e.SEED_ADMIN_EMAIL.toLowerCase();
  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`Super Admin ${email} already exists — nothing to do.`);
  } else {
    await User.create({
      name: e.SEED_ADMIN_NAME,
      email,
      role: "super_admin",
      passwordHash: await hashPassword(e.SEED_ADMIN_PASSWORD),
      emailVerified: true,
      mustChangePassword: false, // the admin chose this password; no forced change
    });
    console.log(`Created Super Admin ${email}. Sign in with SEED_ADMIN_PASSWORD (you can change it any time from the key icon).`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
