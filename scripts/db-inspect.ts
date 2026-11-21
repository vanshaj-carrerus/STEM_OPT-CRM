/**
 * READ-ONLY database diagnostic. Connects with the app's own connection code and reports connectivity, topology,
 * permissions and what already exists. It never writes, creates indexes, or drops anything.
 * Usage: npm run db:inspect
 */
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch {}

async function main() {
  const { env } = await import("../src/lib/env");
  const { connectDb } = await import("../src/lib/db/connect");
  const mongoose = (await import("mongoose")).default;

  const e = env();
  const t0 = Date.now();
  await connectDb();
  const conn = mongoose.connection;
  const db = conn.db!;
  console.log(`CONNECTED in ${Date.now() - t0} ms · database "${conn.name}" · readyState=${conn.readyState}`);

  const ping = await db.admin().ping();
  console.log("ping:", JSON.stringify(ping));

  const hello = (await db.admin().command({ hello: 1 })) as Record<string, unknown>;
  const build = (await db.admin().command({ buildInfo: 1 })) as { version: string };
  console.log(`server version: ${build.version}`);
  console.log(`topology: ${hello.setName ? `replica set "${hello.setName}" (${(hello.hosts as string[] | undefined)?.length ?? "?"} members)` : "standalone (NO transactions)"}`);
  console.log(`primary: ${hello.isWritablePrimary ? "this node is writable primary" : "connected to a non-primary"}`);

  const st = (await db.admin().command({ connectionStatus: 1, showPrivileges: false })) as {
    authInfo: { authenticatedUsers: { user: string; db: string }[]; authenticatedUserRoles: { role: string; db: string }[] };
  };
  console.log("authenticated roles:", st.authInfo.authenticatedUserRoles.map((r) => `${r.role}@${r.db}`).join(", ") || "(none)");

  const dbs = await db.admin().listDatabases({ nameOnly: true }).catch((err: Error) => ({ databases: [], error: err.message }));
  console.log(
    "databases visible:",
    "error" in dbs ? `(cannot list: ${dbs.error})` : (dbs.databases as { name: string }[]).map((d) => d.name).join(", "),
  );

  const cols = await db.listCollections({}, { nameOnly: true }).toArray();
  console.log(`\ncollections in "${conn.name}": ${cols.length}`);
  for (const c of cols.sort((a, b) => a.name.localeCompare(b.name))) {
    const n = await db.collection(c.name).estimatedDocumentCount();
    console.log(`  ${c.name.padEnd(28)} ${n} docs`);
  }
  if (e.MONGODB_DB !== conn.name) console.log("WARNING: connected db differs from MONGODB_DB");

  await mongoose.disconnect();
  console.log("\nDisconnected cleanly. (No writes were performed.)");
}

main().catch((err) => {
  const m = String(err?.message ?? err);
  console.error("\nFAILED:", m.split("\n")[0]);
  if (/ENOTFOUND|querySrv|ECONNREFUSED/i.test(m)) console.error("→ DNS / network problem reaching the cluster (check the host name, your internet, or a firewall/VPN).");
  if (/bad auth|Authentication failed|auth/i.test(m)) console.error("→ Wrong database username/password in MONGODB_URI (special characters in the password must be URL-encoded).");
  if (/ReplicaSetNoPrimary|Server selection timed out|not authorized on.*to execute|IP|whitelist/i.test(m))
    console.error("→ Atlas is probably blocking this machine: add your IP in Atlas → Network Access, then retry.");
  process.exit(1);
});
