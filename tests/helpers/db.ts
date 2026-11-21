import type mongoose from "mongoose";

/**
 * Test database helper.
 *
 *  - Default: in-memory single-node replica set (needs the VC++ runtime on Windows).
 *  - `DB_TEST_ON_ATLAS=1`: use the cluster in .env.local, but ONLY inside a randomly named scratch database
 *    (`dbtest_<random>`), dropped at the end. The application's real database is never written to: every destructive
 *    helper below refuses to run unless the connected database name starts with `dbtest_`.
 */
const SCRATCH_PREFIX = "dbtest_";

type Stoppable = { stop(): Promise<unknown> };
let rs: Stoppable | null = null;
let usingAtlas = false;
// Use the SAME mongoose instance the application connected with (the test runner can load two copies).
let m: typeof mongoose | null = null;
const conn = () => {
  if (!m) throw new Error("Test database is not started");
  return m.connection;
};

function assertScratch(name: string | undefined) {
  if (!name || !name.startsWith(SCRATCH_PREFIX)) {
    throw new Error(`Refusing to run a destructive test helper on database "${name}" (only "${SCRATCH_PREFIX}*" scratch databases are allowed).`);
  }
}

export async function startTestDb() {
  const scratch = SCRATCH_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  if (process.env.DB_TEST_ON_ATLAS === "1") {
    try {
      process.loadEnvFile(".env.local");
    } catch {}
    const realDb = process.env.MONGODB_DB;
    if (!process.env.MONGODB_URI || /PASTE_YOUR/i.test(process.env.MONGODB_URI)) throw new Error("MONGODB_URI is not configured in .env.local");
    // never let a test send real email, whatever .env.local contains
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;
    process.env.MONGODB_DB = scratch;
    if (realDb && realDb === scratch) throw new Error("Scratch database name collided with the real database");
    usingAtlas = true;
  } else {
    const { MongoMemoryReplSet } = await import("mongodb-memory-server");
    const mem = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    rs = mem;
    process.env.MONGODB_URI = mem.getUri();
    process.env.MONGODB_DB = scratch;
  }

  const { connectDb } = await import("@/lib/db/connect");
  m = await connectDb();
  assertScratch(conn().name);
  // make sure every collection + index exists up front, like a freshly deployed app
  await Promise.all(Object.values(m.models).map((model) => model.init()));
}

export async function stopTestDb() {
  if (m && usingAtlas && conn().readyState === 1) {
    const name = conn().name;
    assertScratch(name);
    const client = conn().getClient();
    // Background work (index builds, late writes from a job that just finished) can re-create the database right after a
    // drop, so drop, give it a moment to settle, and confirm — never leave a scratch database behind.
    for (let i = 0; i < 3; i++) {
      await client.db(name).dropDatabase();
      await new Promise((r) => setTimeout(r, 400));
      const names = (await client.db("admin").admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
      if (!names.includes(name)) break;
    }
  }
  await m?.disconnect();
  m = null;
  await rs?.stop();
  rs = null;
  usingAtlas = false;
}

export async function clearCollections() {
  assertScratch(conn().name);
  const cols = await conn().db!.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
}
