import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, stopTestDb } from "../helpers/db";
import type { SessionUser } from "@/lib/auth/session";

const mgr = { id: "mgr", role: "compliance_manager", email: "m@x.test", name: "Mgr", timezone: "America/New_York", mustChangePassword: false, sessionId: "s", extraPermissions: ["sensitive.sevis.view", "sensitive.dob.view"] } as unknown as SessionUser;

describe("roster import commit (needs MongoDB)", () => {
  beforeAll(startTestDb);
  afterAll(stopTestDb);

  const csv = (rows: string[]) => Buffer.from(["Legal Name,Email,SEVIS ID", ...rows].join("\n"));

  it("requires the master-roster confirmation, skips duplicates, never aborts, and wipes rows", async () => {
    const { createImportPreview, commitImport, ImportError } = await import("@/lib/import/service");
    const { ImportRow, ImportJob } = await import("@/lib/db/models/import-job");
    const { Candidate } = await import("@/lib/db/models/candidate");
    const p = await createImportPreview(mgr, "roster.csv", csv(["Ada Lovelace,ada@x.test,N001", "Ada Again,ADA@x.test,", "Grace Hopper,grace@x.test,N002", "Bad,not-an-email,"]));
    expect(p.summary).toMatchObject({ valid: 2, duplicate_file: 1, invalid: 1 });
    expect(await Candidate.countDocuments()).toBe(0); // preview creates nothing
    await expect(commitImport(mgr, p.jobId, { confirmMasterRoster: false, duplicateHandling: "skip" })).rejects.toBeInstanceOf(ImportError);
    const r = await commitImport(mgr, p.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" });
    expect(r).toMatchObject({ created: 2, skipped: 2, failed: 0 });
    expect(await Candidate.countDocuments()).toBe(2);
    expect(await ImportRow.countDocuments({ jobId: p.jobId })).toBe(0);
    expect((await ImportJob.findById(p.jobId))!.status).toBe("committed");
    await expect(commitImport(mgr, p.jobId, { confirmMasterRoster: true, duplicateHandling: "skip" })).rejects.toBeInstanceOf(ImportError); // no double commit
  });

  it("flags rows that already exist in the CRM as duplicates on a second upload", async () => {
    const { createImportPreview } = await import("@/lib/import/service");
    const p = await createImportPreview(mgr, "again.csv", csv(["Ada Lovelace,ada@x.test,N001", "New Person,new@x.test,"]));
    expect(p.summary).toMatchObject({ duplicate_db: 1, valid: 1 });
  });
});
