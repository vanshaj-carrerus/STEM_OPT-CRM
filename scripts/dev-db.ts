/**
 * Local development MongoDB (single-node replica set so transactions work), persisted under .data/mongo.
 * Usage: npm run dev:db     (leave running in its own terminal)
 * Then use MONGODB_URI=mongodb://127.0.0.1:27018/?replicaSet=rs0 in .env.local
 * For production use MongoDB Atlas (or any replica set) instead.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const dbPath = resolve(process.cwd(), ".data", "mongo");
  mkdirSync(dbPath, { recursive: true });
  const rs = await MongoMemoryReplSet.create({
    replSet: { name: "rs0", count: 1, storageEngine: "wiredTiger", dbName: "stem_opt_crm" },
    instanceOpts: [{ port: 27018, dbPath, storageEngine: "wiredTiger" }],
  });
  console.log(`\nDev MongoDB ready: ${rs.getUri()}\nData dir: ${dbPath}\nPress Ctrl+C to stop.\n`);
  const stop = async () => {
    await rs.stop({ doCleanup: false });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
