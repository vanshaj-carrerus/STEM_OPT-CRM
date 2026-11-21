/**
 * Database verification.
 *
 *   npm run db:verify            → writes ONLY into a throw-away scratch database (dbcheck_*), always dropped afterwards.
 *   npm run db:verify -- --real  → READ-ONLY checks of the real database (index comparison + validating existing documents).
 *
 * The real database is never written to: in scratch mode the database name is forced to `dbcheck_*` and every destructive
 * call asserts it; in --real mode no write method is called at all.
 */
import { loadEnvFile } from "node:process";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

try {
  loadEnvFile(".env.local");
} catch {}

const args = new Set(process.argv.slice(2));
const REAL = args.has("--real");
const PHASE = process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "all";
const STATE = ".data/dbcheck-state.json";

let pass = 0;
let fail = 0;
const failures: string[] = [];
const warnings: string[] = [];
const ok = (m: string) => {
  pass++;
  console.log(`  ✓ ${m}`);
};
const bad = (m: string) => {
  fail++;
  failures.push(m);
  console.log(`  ✗ ${m}`);
};
const check = (cond: unknown, m: string) => (cond ? ok(m) : bad(m));

process.on("warning", (w) => {
  if (/MONGOOSE/.test(w.message)) warnings.push(w.message.replace(/\s+/g, " ").slice(0, 220));
});

type Mongoose = typeof import("mongoose");
type AnyModel = import("mongoose").Model<any>;

async function main() {
  // never email anyone from a verification run
  delete process.env.EMAIL_USER;
  delete process.env.EMAIL_PASS;

  // the child process (restart test) is given the REAL name explicitly so it can still tell scratch from real
  const realDb = process.env.REAL_MONGODB_DB ?? process.env.MONGODB_DB ?? "stem_opt_crm";
  let scratch = "";
  if (!REAL) {
    scratch = PHASE === "read" ? JSON.parse(readFileSync(STATE, "utf8")).name : `dbcheck_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    if (!scratch.startsWith("dbcheck_") || scratch === realDb) throw new Error("Refusing: scratch database name is invalid");
    process.env.MONGODB_DB = scratch;
  }

  const { connectDb } = await import("../src/lib/db/connect");
  const mongoose = await connectDb();
  const conn = mongoose.connection;
  console.log(`\nConnected to "${conn.name}" (${REAL ? "REAL database — READ-ONLY checks" : "scratch database — will be dropped"})\n`);
  if (!REAL && (!conn.name.startsWith("dbcheck_") || conn.name === realDb)) throw new Error("Safety stop: not a scratch database");

  // load every model file so all collections register
  for (const f of readdirSync("src/lib/db/models")) if (f.endsWith(".ts")) await import(`../src/lib/db/models/${f}`);
  const models = Object.values(mongoose.models) as AnyModel[];
  console.log(`Registered ${models.length} models: ${models.map((m) => m.collection.collectionName).sort().join(", ")}\n`);

  try {
    if (REAL) await realReadOnly(mongoose, models);
    else if (PHASE === "read") await persistenceRead(mongoose, models, scratch);
    else await scratchSuite(mongoose, models, scratch, realDb);
  } finally {
    // safety net: whatever happened above, never leave the scratch database behind (name is guaranteed dbcheck_*)
    if (!REAL && PHASE !== "read" && conn.name.startsWith("dbcheck_") && conn.name !== realDb) {
      await conn.dropDatabase().catch(() => undefined);
      const left = (await conn.getClient().db("admin").admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
      if (left.includes(conn.name)) await conn.getClient().db(conn.name).dropDatabase().catch(() => undefined);
      const after = (await conn.getClient().db("admin").admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
      check(!after.includes(conn.name), "scratch database was dropped (nothing left behind)");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (warnings.length) {
    console.log(`\nMongoose warnings (${warnings.length}):`);
    for (const w of [...new Set(warnings)]) console.log(`  ! ${w}`);
  }
  if (fail) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
}

/* ------------------------------ index comparison ------------------------------ */

const keyOf = (k: Record<string, unknown>) => JSON.stringify(Object.entries(k));

/**
 * Every index declared in a schema must really exist in MongoDB with the same key, uniqueness and partial filter.
 * (Mongoose silently skips an index when MongoDB reports a name collision — e.g. an UNNAMED unique-partial index sharing
 * a key with a plain index — so "declared" does not imply "present".)
 */
async function compareIndexes(models: AnyModel[], real: boolean) {
  console.log("Indexes: declared in schema vs present in MongoDB");
  for (const m of models) {
    const name = m.collection.collectionName;
    const declared = m.schema.indexes() as [Record<string, unknown>, Record<string, any>][];
    let actual: Record<string, any>[] = [];
    try {
      actual = (await m.collection.indexes()) as Record<string, any>[];
    } catch {
      if (real) {
        console.log(`  - ${name}: collection does not exist yet in the real database (indexes are created on first use)`);
        continue;
      }
      throw new Error(`cannot read indexes of ${name}`);
    }
    let missing = 0;
    for (const [key, opt] of declared) {
      if (Object.values(key).includes("text")) {
        const t = actual.find((a) => a.key && "_fts" in a.key); // text indexes are stored under internal _fts keys
        if (t) ok(`${name}: text index present (${Object.keys(t.weights ?? {}).join(", ")})`);
        else {
          missing++;
          bad(`${name}: text index MISSING`);
        }
        continue;
      }
      const found = actual.find(
        (a) => keyOf(a.key) === keyOf(key) && !!a.unique === !!opt.unique && JSON.stringify(a.partialFilterExpression ?? null) === JSON.stringify(opt.partialFilterExpression ?? null),
      );
      if (!found) {
        missing++;
        const why = actual.some((a) => keyOf(a.key) === keyOf(key)) ? "exists with different options (unique/partial)" : "MISSING";
        const msg = `${name}: index ${keyOf(key)}${opt.unique ? " [unique]" : ""}${opt.partialFilterExpression ? " [partial]" : ""} → ${why}`;
        if (real) warnings.push(msg);
        else bad(msg);
        console.log(`  ${real ? "!" : "✗"} ${msg}`);
      } else if (opt.expireAfterSeconds !== undefined && found.expireAfterSeconds !== opt.expireAfterSeconds) {
        bad(`${name}: TTL on ${keyOf(key)} not applied (expected ${opt.expireAfterSeconds}s, got ${found.expireAfterSeconds})`);
      }
    }
    if (!missing) ok(`${name}: all ${declared.length} declared indexes present (${actual.length} total incl. _id)`);
  }
}

/* ------------------------------ fixtures ------------------------------ */

let counter = 0;
/** A minimal VALID document generated from the schema's own required paths / enums. */
function fixture(model: AnyModel, overrides: Record<string, unknown> = {}) {
  const n = ++counter;
  const doc: Record<string, any> = {};
  for (const [path, type] of Object.entries<any>(model.schema.paths)) {
    if (path === "_id" || path === "__v" || path === "createdAt" || path === "updatedAt") continue;
    if (!type.isRequired || path.includes(".$")) continue;
    let v: unknown;
    switch (type.instance) {
      case "String":
        v = type.enumValues?.length ? type.enumValues[0] : `${path.replace(/\W/g, "")}-${n}-${Math.random().toString(36).slice(2, 7)}`;
        if (type.options?.lowercase) v = String(v).toLowerCase();
        break;
      case "Number":
        v = type.options?.min ?? 1;
        break;
      case "Boolean":
        v = true;
        break;
      case "Date":
        v = new Date();
        break;
      case "Array":
        v = [];
        break;
      default:
        v = {};
    }
    const parts = path.split(".");
    let cur: Record<string, any> = doc;
    parts.slice(0, -1).forEach((p) => (cur = cur[p] ??= {}));
    cur[parts[parts.length - 1]] = v;
  }
  const idType: any = (model.schema.paths as any)._id;
  if (idType && !idType.defaultValue && !idType.options?.default) doc._id = `fx-${n}-${Math.random().toString(36).slice(2, 6)}`;
  const special: Record<string, Record<string, unknown>> = { payments: { currency: "USD" } }; // strict format (^[A-Z]{3}$)
  return { ...doc, ...(special[model.collection.collectionName] ?? {}), ...overrides };
}

const APPEND_ONLY = new Set(["audit_events", "payment_events", "payroll_sync_logs"]);

/* ------------------------------ scratch suite ------------------------------ */

async function scratchSuite(mongoose: Mongoose, models: AnyModel[], scratch: string, realDbName: string) {
  const conn = mongoose.connection;

  console.log("1. Connection & topology");
  check((await conn.db!.admin().ping()).ok === 1, "ping ok");
  const hello = (await conn.db!.admin().command({ hello: 1 })) as Record<string, unknown>;
  check(!!hello.setName, `replica set "${hello.setName}" (transactions supported)`);

  console.log("\n2. Collections & indexes are created from the schemas");
  await Promise.all(models.map((m) => m.init()));
  const cols = (await conn.db!.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  for (const m of models) check(cols.includes(m.collection.collectionName), `collection "${m.collection.collectionName}" exists`);
  await compareIndexes(models, false);

  console.log("\n3. Validation (required fields, enums) rejects bad documents");
  for (const m of models) {
    const name = m.collection.collectionName;
    const required = Object.entries<any>(m.schema.paths).filter(([p, t]) => t.isRequired && p !== "_id" && !p.includes(".$"));
    if (required.length) {
      const [p] = required[0];
      const doc: Record<string, any> = fixture(m);
      const parts = p.split(".");
      let cur: any = doc;
      parts.slice(0, -1).forEach((x) => (cur = cur[x]));
      delete cur[parts[parts.length - 1]];
      const err = await new m(doc).validate().then(() => null, (e: any) => e);
      check(err?.name === "ValidationError", `${name}: missing required "${p}" is rejected`);
    }
    const enumPath = Object.entries<any>(m.schema.paths).find(([p, t]) => t.instance === "String" && t.enumValues?.length && !p.includes("."));
    if (enumPath) {
      const err = await new m(fixture(m, { [enumPath[0]]: "__not_a_valid_value__" })).validate().then(() => null, (e: any) => e);
      check(err?.name === "ValidationError", `${name}: invalid enum value for "${enumPath[0]}" is rejected`);
    }
  }

  console.log("\n4. Create → read → update on every collection");
  for (const m of models) {
    const name = m.collection.collectionName;
    try {
      const doc = await m.create(fixture(m));
      const back = await m.findById(doc._id).lean<any>();
      check(!!back && String(back._id) === String(doc._id), `${name}: saved and read back`);
      check(typeof back._id === "string", `${name}: _id is a string`);
      if (m.schema.get("timestamps")) check(back.createdAt instanceof Date, `${name}: createdAt timestamp set`);
      if (APPEND_ONLY.has(name)) {
        const e1 = await m.updateOne({ _id: doc._id }, { $set: { zzz: 1 } }).then(() => null, (e: Error) => e);
        const e2 = await m.deleteOne({ _id: doc._id }).then(() => null, (e: Error) => e);
        check(!!e1 && !!e2, `${name}: append-only (update and delete both rejected)`);
      } else {
        const strField = Object.entries<any>(m.schema.paths).find(
          ([p, t]) => t.instance === "String" && !t.enumValues?.length && !p.includes(".") && p !== "_id" && !t.options?.unique && !t.options?.lowercase,
        );
        if (strField) {
          const upd = await m.findByIdAndUpdate(doc._id, { $set: { [strField[0]]: "updated-value" } }, { returnDocument: "after" }).lean<any>().catch((e: Error) => e);
          if (upd instanceof Error) ok(`${name}: update guarded by model rules (${upd.message.slice(0, 70)})`);
          else check(upd?.[strField[0]] === "updated-value", `${name}: updated field persisted`);
        }
      }
    } catch (e) {
      bad(`${name}: create failed — ${(e as Error).message.slice(0, 160)}`);
    }
  }

  console.log("\n5. Unique constraints are enforced by MongoDB (real duplicate-key errors)");
  let probed = 0;
  for (const m of models) {
    const name = m.collection.collectionName;
    const uniques = (m.schema.indexes() as [Record<string, number>, Record<string, any>][]).filter(([, o]) => o.unique);
    for (const [key, opt] of uniques) {
      const fields = Object.keys(key);
      if (fields.every((f) => f === "_id")) continue;
      const pf = (opt.partialFilterExpression ?? {}) as Record<string, any>;
      // make the probe rows fall INSIDE the index: key fields get a value, literal partial-filter fields get their literal
      const over: Record<string, unknown> = {};
      for (const f of fields) over[f] = pf[f] === undefined || pf[f]?.$type === "string" ? "probe-key" : pf[f];
      for (const [k, v] of Object.entries(pf)) if (!(k in over) && (typeof v !== "object" || v === null)) over[k] = v;
      const first: Record<string, any> = { ...fixture(m, over), _id: `u1-${Math.random().toString(36).slice(2, 8)}` };
      const second: Record<string, any> = { ...fixture(m, over), _id: `u2-${Math.random().toString(36).slice(2, 8)}` };
      // the second row may collide ONLY on this index, so keep every other string field distinct
      for (const k of Object.keys(first)) if (!fields.includes(k) && !(k in pf) && k !== "_id" && typeof first[k] === "string") second[k] = `${first[k]}-b`;
      try {
        await m.collection.insertOne(first as never);
      } catch (e) {
        console.log(`  - ${name}: could not seed a probe row for [${fields.join(", ")}] (${(e as Error).message.slice(0, 70)})`);
        continue;
      }
      const err: any = await m.collection.insertOne(second as never).then(() => null, (e: unknown) => e);
      probed++;
      check(err?.code === 11000, `${name}: duplicate on [${fields.join(", ")}]${opt.partialFilterExpression ? " (partial)" : ""} → E11000`);
      await m.collection.deleteMany({ _id: { $in: [first._id, second._id] } as never }).catch(() => undefined);
    }
  }
  check(probed >= 15, `probed ${probed} unique indexes with real duplicate inserts`);

  console.log("\n6. Special rules");
  {
    const { Candidate } = await import("../src/lib/db/models/candidate");
    const { EmergencyPayrollItem } = await import("../src/lib/db/models/emergency-payroll-item");
    const e1 = fixture(EmergencyPayrollItem, { candidateId: "cand-x", isActive: true, requestedPayDate: "2026-01-01" });
    await EmergencyPayrollItem.create(e1);
    const dupErr: any = await EmergencyPayrollItem.create({ ...e1, _id: "other" }).then(() => null, (e: unknown) => e);
    check(dupErr?.code === 11000, "emergency payroll: only ONE active item per candidate (database-enforced)");
    await EmergencyPayrollItem.updateOne({ candidateId: "cand-x", isActive: true }, { $set: { isActive: false, status: "resolved" } });
    check(await EmergencyPayrollItem.create({ ...e1, _id: "third" }).then(() => true, () => false), "emergency payroll: a new item is allowed once the previous one is resolved");

    const c1 = fixture(Candidate, { emailLower: "dup@example.com", email: "dup@example.com", candidateCode: "CND-DUP-1" });
    await Candidate.create(c1);
    const e: any = await Candidate.create({ ...c1, _id: "c2", candidateCode: "CND-DUP-2" }).then(() => null, (x: unknown) => x);
    check(e?.code === 11000, "candidates: same email cannot be stored twice");
    await Candidate.create(fixture(Candidate, { sevisHash: "h-1", candidateCode: "CND-S-1" }));
    const e2: any = await Candidate.create(fixture(Candidate, { sevisHash: "h-1", candidateCode: "CND-S-2" })).then(() => null, (x: unknown) => x);
    check(e2?.code === 11000, "candidates: same SEVIS hash cannot be stored twice");
    const a = await Candidate.create(fixture(Candidate, { candidateCode: "CND-N-1" })).then(() => true, () => false);
    const b = await Candidate.create(fixture(Candidate, { candidateCode: "CND-N-2" })).then(() => true, () => false);
    check(a && b, "candidates: two candidates WITHOUT a SEVIS ID can coexist (partial unique index)");
  }
  {
    const session = await mongoose.startSession();
    try {
      const { Counter } = await import("../src/lib/db/models/counter");
      await session.withTransaction(async () => {
        await Counter.create([{ _id: "txn-probe", seq: 1 }], { session });
      });
      check((await Counter.findById("txn-probe").lean<any>())?.seq === 1, "multi-document transactions work on this cluster");
    } catch (e) {
      bad(`transactions failed: ${(e as Error).message.slice(0, 120)}`);
    } finally {
      await session.endSession();
    }
  }
  {
    const { nextSequence } = await import("../src/lib/db/models/counter");
    const seq = await Promise.all(Array.from({ length: 20 }, () => nextSequence("probe-parallel")));
    check(new Set(seq).size === 20, "candidate-code counter is atomic under 20 parallel requests (no duplicates)");
  }

  console.log("\n7. Persistence across an application restart");
  const { Candidate } = await import("../src/lib/db/models/candidate");
  const { User } = await import("../src/lib/db/models/user");
  const { hashPassword } = await import("../src/lib/auth/password");
  const marker = `persist-${Date.now()}`;
  await User.create({ name: "Persist Check", email: `${marker}@example.test`, passwordHash: await hashPassword("x"), role: "auditor" });
  await Candidate.create(fixture(Candidate, { legalName: marker, emailLower: `${marker}@example.test`, email: `${marker}@example.test`, candidateCode: `CND-${marker}` }));
  mkdirSync(".data", { recursive: true });
  writeFileSync(STATE, JSON.stringify({ name: scratch, marker }));
  console.log("  … starting a brand-new process (fresh connection, empty caches) to read the data back");
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/db-verify.ts", "--phase=read"], {
    stdio: "inherit",
    env: { ...process.env, MONGODB_DB: scratch, REAL_MONGODB_DB: realDbName },
  });
  check(child.status === 0, "data written by process 1 was read back by a fresh process 2");
  rmSync(STATE, { force: true });
}

/* ------------------------------ restart phase ------------------------------ */

async function persistenceRead(mongoose: Mongoose, models: AnyModel[], scratch: string) {
  const { marker } = JSON.parse(readFileSync(STATE, "utf8"));
  const { Candidate } = await import("../src/lib/db/models/candidate");
  const { User } = await import("../src/lib/db/models/user");
  const u = await User.findOne({ email: `${marker}@example.test` }).lean<any>();
  const c = await Candidate.findOne({ legalName: marker }).lean<any>();
  check(!!u && u.role === "auditor", "[new process] user survived the restart");
  check(!!c && c.candidateCode === `CND-${marker}`, "[new process] candidate survived the restart");
  const counts = await Promise.all(models.map(async (m) => [m.collection.collectionName, await m.estimatedDocumentCount()] as const));
  const nonEmpty = counts.filter(([, n]) => n > 0).length;
  check(nonEmpty >= 10, `[new process] ${nonEmpty} collections still hold their documents`);
  void mongoose;
  void scratch; // the scratch database is dropped by the parent process's cleanup step
}

/* ------------------------------ real database (read-only) ------------------------------ */

async function realReadOnly(mongoose: Mongoose, models: AnyModel[]) {
  console.log("A. Existing documents validate against the CURRENT schemas (read-only)");
  for (const m of models) {
    const name = m.collection.collectionName;
    const exists = (await mongoose.connection.db!.listCollections({ name }).toArray()).length > 0;
    if (!exists) {
      console.log(`  - ${name}: no collection yet`);
      continue;
    }
    const docs = await m.find({}).limit(2000).lean<any[]>();
    if (!docs.length) {
      console.log(`  - ${name}: empty`);
      continue;
    }
    let invalid = 0;
    for (const d of docs) {
      const err = await new m(d).validate().then(() => null, (e: any) => e);
      if (err) {
        invalid++;
        bad(`${name}/${d._id}: ${Object.values<any>(err.errors ?? {}).map((x) => x.message).join("; ").slice(0, 200)}`);
      }
    }
    if (!invalid) ok(`${name}: all ${docs.length} existing documents are valid`);
  }
  console.log("\nB. Existing indexes vs schema");
  await compareIndexes(models, true);
}

main().catch((e) => {
  console.error("\nVERIFY FAILED:", e?.message ?? e);
  process.exit(1);
});
