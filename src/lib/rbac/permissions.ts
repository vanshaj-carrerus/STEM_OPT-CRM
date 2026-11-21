/** Every permission in the system. UI and API both check these keys through `can()`. */
export const PERMISSIONS = [
  "dashboard.view",

  "candidates.view", // basic profile (name, code, employer, status)
  "candidates.viewAll", // not limited to assigned candidates
  "candidates.create",
  "candidates.edit",
  "candidates.assign",
  "candidates.import",
  "candidates.export",

  "sensitive.sevis.view",
  "sensitive.ead.view",
  "sensitive.dob.view",
  "sensitive.employerIds.view", // EIN, E-Verify company ID
  "sensitive.tax.view",

  "immigration.view",
  "immigration.edit",
  "immigration.verify", // verify authorization evidence / clear to work

  "documents.view",
  "documents.upload",
  "documents.verify",
  "documents.download",

  "tracker.view",
  "tracker.edit",
  "tracker.signoff", // manager sign-off on monthly review / cycle close

  "tasks.view",
  "tasks.edit",
  "reminders.manage",

  "payroll.view",
  "payroll.prepare",
  "payroll.approve",
  "payroll.amounts.view", // gross/net/pay rate
  "payroll.reconcile",

  "emergency.view",
  "emergency.manage",
  "emergency.resolve",
  "emergency.override", // approved exception / manual removal

  "payments.view",
  "payments.prepare",
  "payments.submit",
  "payments.approve",
  "payments.reconcile",
  "payments.destination.view", // masked destination reference visibility

  "reports.view",
  "reports.export",
  "audit.view",

  "admin.users",
  "admin.settings",
  "admin.integrations",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  "super_admin",
  "compliance_manager",
  "compliance_associate",
  "payroll_preparer",
  "payroll_approver",
  "finance_operator",
  "finance_approver",
  "auditor",
  "candidate_portal",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  compliance_manager: "Compliance Manager",
  compliance_associate: "Compliance Associate",
  payroll_preparer: "Payroll Preparer",
  payroll_approver: "Payroll Approver",
  finance_operator: "Finance Operator",
  finance_approver: "Finance Approver",
  auditor: "Auditor / Read Only",
  candidate_portal: "Candidate Portal User",
};

/** Roles that must always complete email OTP and cannot have MFA waived. */
export const MFA_MANDATORY_ROLES: Role[] = ["super_admin", "payroll_approver", "finance_approver", "compliance_manager"];

const SENSITIVE = PERMISSIONS.filter((p) => p.startsWith("sensitive."));
const ALL = [...PERMISSIONS];

const complianceBase: Permission[] = [
  "dashboard.view",
  "candidates.view",
  "candidates.create",
  "candidates.edit",
  "immigration.view",
  "immigration.edit",
  "documents.view",
  "documents.upload",
  "documents.download",
  "tracker.view",
  "tracker.edit",
  "tasks.view",
  "tasks.edit",
  "reports.view",
  "sensitive.sevis.view",
  "sensitive.ead.view",
  "sensitive.dob.view",
  "sensitive.employerIds.view",
];

/**
 * Role → permission matrix (long spec §9).
 * - Super Admin gets every module permission but NOT sensitive.* — those must be explicitly granted (and are logged).
 * - Compliance Associate is limited to assigned candidates (no `candidates.viewAll`).
 * - Payroll roles have no immigration/document access unless separately granted.
 * - Finance operator sees masked recipient details only (no destination.view).
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: ALL.filter((p) => !SENSITIVE.includes(p as never)),
  compliance_manager: [
    ...complianceBase,
    "candidates.viewAll",
    "candidates.assign",
    "candidates.import",
    "candidates.export",
    "immigration.verify",
    "documents.verify",
    "tracker.signoff",
    "reminders.manage",
    "reports.export",
    "emergency.view",
    "emergency.override",
    "audit.view",
  ],
  compliance_associate: [...complianceBase, "documents.verify"],
  payroll_preparer: [
    "dashboard.view",
    "candidates.view",
    "candidates.viewAll",
    "payroll.view",
    "payroll.prepare",
    "payroll.amounts.view",
    "emergency.view",
    "emergency.manage",
    "tasks.view",
    "reports.view",
  ],
  payroll_approver: [
    "dashboard.view",
    "candidates.view",
    "candidates.viewAll",
    "payroll.view",
    "payroll.approve",
    "payroll.amounts.view",
    "payroll.reconcile",
    "emergency.view",
    "emergency.resolve",
    "tasks.view",
    "reports.view",
    "reports.export",
  ],
  finance_operator: [
    "dashboard.view",
    "candidates.view",
    "candidates.viewAll",
    "payments.view",
    "payments.prepare",
    "payments.submit",
    "tasks.view",
    "reports.view",
  ],
  finance_approver: [
    "dashboard.view",
    "candidates.view",
    "candidates.viewAll",
    "payments.view",
    "payments.approve",
    "payments.reconcile",
    "payments.destination.view",
    "emergency.view",
    "tasks.view",
    "reports.view",
    "reports.export",
  ],
  auditor: [
    "dashboard.view",
    "candidates.view",
    "candidates.viewAll",
    "immigration.view",
    "documents.view",
    "tracker.view",
    "tasks.view",
    "payroll.view",
    "emergency.view",
    "payments.view",
    "reports.view",
    "audit.view",
  ],
  candidate_portal: [],
};
