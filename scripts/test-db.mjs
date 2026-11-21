// Runs the DB-backed tests against the Atlas cluster in .env.local, inside throw-away scratch databases only,
// then sweeps any scratch database a late background write may have re-created after the test's own drop.
// Usage: npm run test:db
import { spawnSync } from "node:child_process";

const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/db"], {
  stdio: "inherit",
  env: { ...process.env, DB_TEST_ON_ATLAS: "1", RUN_DB_TESTS: "1", NODE_NO_WARNINGS: "1" },
});

// only ever drops databases named dbtest_* / dbcheck_* — never the real database (see scripts/db-cleanup-scratch.ts)
spawnSync(process.execPath, ["--import", "tsx", "scripts/db-cleanup-scratch.ts"], { stdio: "inherit" });

process.exit(r.status ?? 1);
