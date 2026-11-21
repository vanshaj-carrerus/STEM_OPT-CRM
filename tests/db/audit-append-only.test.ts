import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, stopTestDb } from "../helpers/db";

describe("audit log is append-only (AC-16 foundation)", () => {
  beforeAll(startTestDb);
  afterAll(stopTestDb);

  it("allows create but rejects update and delete", async () => {
    const { AuditEvent } = await import("@/lib/db/models/audit");
    const ev = await AuditEvent.create({ entityType: "test", action: "create", summary: "hello" });
    await expect(AuditEvent.updateOne({ _id: ev._id }, { $set: { summary: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(AuditEvent.deleteOne({ _id: ev._id })).rejects.toThrow(/append-only/);
    await expect(AuditEvent.deleteMany({})).rejects.toThrow(/append-only/);
    ev.summary = "changed";
    await expect(ev.save()).rejects.toThrow(/append-only/);
    expect(await AuditEvent.countDocuments()).toBe(1);
  });

  it("redacts secrets from before/after", async () => {
    const { audit } = await import("@/lib/audit");
    const { AuditEvent } = await import("@/lib/db/models/audit");
    await audit({ action: "update", entityType: "user", after: { email: "a@b.c", passwordHash: "xyz", nested: { token: "t" } } });
    const last = await AuditEvent.findOne({ entityType: "user" }).lean<{ after: Record<string, unknown> }>();
    expect(last!.after.passwordHash).toBe("[redacted]");
    expect((last!.after.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect(last!.after.email).toBe("a@b.c");
  });
});
