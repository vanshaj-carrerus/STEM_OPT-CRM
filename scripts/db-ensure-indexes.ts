/**
 * Creates any index declared in the Mongoose schemas that is MISSING from the configured database.
 *
 *   npm run db:indexes             → report what is missing (dry run, changes nothing)
 *   npm run db:indexes -- --apply  → create only the missing indexes
 *
 * Non-destructive by design: it never drops, renames or rewrites an index and never touches documents
 * (that is why it does not use Model.syncIndexes(), which drops indexes). A unique index that cannot be built because
 * existing data violates it is reported and skipped rather than forced.
 */
import { loadEnvFile } from "node:process";
import { readdirSync } from "node:fs";

try {
  loadEnvFile(".env.local");
} catch {}

const APPLY = process.argv.includes("--apply");
const keyOf = (k: Record<string, unknown>) => JSON.stringify(Object.entries(k));

async function main() {
  const { connectDb } = await import("../src/lib/db/connect");
  const mongoose = await connectDb();
  console.log(`Database "${mongoose.connection.name}" — ${APPLY ? "APPLY mode (creates missing indexes only)" : "dry run (no changes)"}\n`);
  for (const f of readdirSync("src/lib/db/models")) if (f.endsWith(".ts")) await import(`../src/lib/db/models/${f}`);

  let missing = 0;
  let created = 0;
  let problems = 0;
  for (const m of Object.values(mongoose.models)) {
    const name = m.collection.collectionName;
    const exists = (await mongoose.connection.db!.listCollections({ name }).toArray()).length > 0;
    const actual = exists ? ((await m.collection.indexes()) as Record<string, any>[]) : [];
    const declared = m.schema.indexes() as [Record<string, any>, Record<string, any>][];
    for (const [key, opt] of declared) {
      if (Object.values(key).includes("text")) {
        if (actual.some((a) => a.key && "_fts" in a.key)) continue;
      } else if (
        actual.some(
          (a) =>
            keyOf(a.key) === keyOf(key) &&
            !!a.unique === !!opt.unique &&
            JSON.stringify(a.partialFilterExpression ?? null) === JSON.stringify(opt.partialFilterExpression ?? null),
        )
      )
        continue;
      missing++;
      const label = `${name}: ${keyOf(key)}${opt.unique ? " [unique]" : ""}${opt.partialFilterExpression ? " [partial]" : ""}${opt.name ? ` (${opt.name})` : ""}`;
      if (!APPLY) {
        console.log(`  missing  ${label}`);
        continue;
      }
      try {
        const { background: _bg, ...options } = opt; // eslint-disable-line @typescript-eslint/no-unused-vars
        await m.collection.createIndex(key as never, options as never);
        created++;
        console.log(`  created  ${label}`);
      } catch (e) {
        problems++;
        console.log(`  SKIPPED  ${label}\n           → ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }
  console.log(`\n${missing === 0 ? "No missing indexes." : APPLY ? `${created} created, ${problems} skipped.` : `${missing} missing — run with --apply to create them.`}`);
  await mongoose.disconnect();
  process.exit(problems ? 1 : 0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
