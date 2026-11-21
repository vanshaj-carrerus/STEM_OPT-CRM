/**
 * Drops leftover SCRATCH databases created by the verification tooling (names starting with `dbcheck_` or `dbtest_`).
 * It can never touch the application's real database: any other name is skipped, and the configured MONGODB_DB is
 * explicitly protected. Usage: npm run db:cleanup-scratch
 */
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch {}

async function main() {
  const { connectDb } = await import("../src/lib/db/connect");
  const mongoose = await connectDb();
  const real = process.env.MONGODB_DB ?? "stem_opt_crm";
  const admin = mongoose.connection.db!.admin();
  const { databases } = await admin.listDatabases({ nameOnly: true });
  const targets = databases.map((d) => d.name).filter((n) => (n.startsWith("dbcheck_") || n.startsWith("dbtest_")) && n !== real);
  if (!targets.length) console.log("No scratch databases found.");
  for (const name of targets) {
    await mongoose.connection.getClient().db(name).dropDatabase();
    console.log(`dropped scratch database ${name}`);
  }
  console.log(`Left untouched: ${databases.map((d) => d.name).filter((n) => !targets.includes(n)).join(", ")}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
