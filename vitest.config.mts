import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// DB-backed tests live in tests/db and need a reachable MongoDB replica set (in-memory mongod needs the
// VC++ runtime on Windows). Run them with:  RUN_DB_TESTS=1 npm test
const runDb = process.env.RUN_DB_TESTS === "1";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    // vitest 4/5 workers fail to initialise under Node 26 with forks/threads; vmThreads works.
    pool: "vmThreads",
    include: ["tests/**/*.test.ts"],
    exclude: runDb ? ["node_modules/**"] : ["node_modules/**", "tests/db/**"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
