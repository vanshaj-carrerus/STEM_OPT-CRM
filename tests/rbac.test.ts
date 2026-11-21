import { describe, expect, it } from "vitest";
import { can, canAccessCandidate, candidateScopeFilter, type Actor } from "@/lib/rbac/can";
import { ROLES, PERMISSIONS } from "@/lib/rbac/permissions";
import { CANDIDATE_FIELD_RULES, stripRestricted } from "@/lib/rbac/mask";

const actor = (role: Actor["role"], extra: Partial<Actor> = {}): Actor => ({ id: `u-${role}`, role, ...extra });

describe("role matrix (long spec §9)", () => {
  it("super admin has all modules but NOT sensitive fields unless explicitly granted", () => {
    const sa = actor("super_admin");
    expect(can(sa, "admin.users")).toBe(true);
    expect(can(sa, "payments.view")).toBe(true);
    expect(can(sa, "sensitive.sevis.view")).toBe(false);
    expect(can(actor("super_admin", { extraPermissions: ["sensitive.sevis.view"] }), "sensitive.sevis.view")).toBe(true);
  });

  it("payroll roles cannot see immigration documents; finance operator cannot see payment destination", () => {
    for (const r of ["payroll_preparer", "payroll_approver"] as const) {
      expect(can(actor(r), "immigration.view")).toBe(false);
      expect(can(actor(r), "documents.view")).toBe(false);
    }
    expect(can(actor("finance_operator"), "payments.destination.view")).toBe(false);
  });

  it("preparers cannot approve and approvers cannot prepare (separation of duties by role)", () => {
    expect(can(actor("payroll_preparer"), "payroll.approve")).toBe(false);
    expect(can(actor("payroll_approver"), "payroll.prepare")).toBe(false);
    expect(can(actor("finance_operator"), "payments.approve")).toBe(false);
    expect(can(actor("finance_approver"), "payments.prepare")).toBe(false);
  });

  it("auditor is read-only: no create/edit/approve/prepare/upload/download permission", () => {
    const a = actor("auditor");
    for (const p of PERMISSIONS) {
      if (can(a, p)) expect(p).toMatch(/\.view(All)?$/);
    }
    expect(can(a, "documents.download")).toBe(false);
  });

  it("candidate portal user gets nothing in the staff app", () => {
    expect(PERMISSIONS.filter((p) => can(actor("candidate_portal"), p))).toEqual([]);
  });

  it("denied permissions override role defaults", () => {
    expect(can(actor("compliance_manager", { deniedPermissions: ["candidates.export"] }), "candidates.export")).toBe(false);
  });

  it("every role is defined", () => {
    expect(ROLES.length).toBe(9);
  });
});

describe("record-level scope", () => {
  it("associates only see assigned candidates", () => {
    const assoc = actor("compliance_associate");
    expect(canAccessCandidate(assoc, { ownerId: assoc.id })).toBe(true);
    expect(canAccessCandidate(assoc, { ownerId: "someone-else" })).toBe(false);
    expect(canAccessCandidate(assoc, { ownerId: "x", teamMemberIds: [assoc.id] })).toBe(true);
    expect(candidateScopeFilter(assoc)).toEqual({ $or: [{ ownerId: assoc.id }, { teamMemberIds: assoc.id }] });
  });
  it("managers see everyone", () => {
    const m = actor("compliance_manager");
    expect(canAccessCandidate(m, { ownerId: "other" })).toBe(true);
    expect(candidateScopeFilter(m)).toEqual({});
  });
});

describe("field masking", () => {
  it("removes restricted identifiers entirely for unauthorized roles", () => {
    const rec = { legalName: "A B", sevisId: { mask: "••••1234" }, eadNumber: { mask: "••••9999" }, dateOfBirth: "x" };
    const forPayroll = stripRestricted(actor("payroll_preparer"), rec, CANDIDATE_FIELD_RULES);
    expect(forPayroll).toEqual({ legalName: "A B" });
    const forManager = stripRestricted(actor("compliance_manager"), rec, CANDIDATE_FIELD_RULES);
    expect(forManager.sevisId).toBeDefined();
  });
});
