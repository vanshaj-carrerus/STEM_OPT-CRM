/**
 * Task enums. DB-free so client components and pure rule modules can import them without bundling Mongoose.
 */
export const TASK_KINDS = [
  "milestone", // STEM validations, I-983 evaluations, authorization expiry warnings
  "monthly_review", // 12-month operational review (month 1..12)
  "change_review", // employer/address/hours/compensation/training-plan change → DSO review task
  "document_request",
  "unemployment_check",
  "payroll", // payroll exception follow-ups
  "payment", // payment exception follow-ups
  "manual",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = [
  "open",
  "in_progress",
  "waiting_candidate",
  "waiting_employer",
  "waiting_dso",
  "completed",
  "waived",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const OPEN_TASK_STATUSES: TaskStatus[] = ["open", "in_progress", "waiting_candidate", "waiting_employer", "waiting_dso"];

export const TASK_CATEGORIES = ["immigration", "tracker", "documents", "payroll", "payments", "general"] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];
