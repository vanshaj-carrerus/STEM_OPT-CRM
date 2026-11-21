import { connectDb } from "@/lib/db/connect";
import { Setting } from "@/lib/db/models/misc";
import { DEFAULT_OFFSETS } from "@/lib/reminders/engine";
import { DEFAULT_HIGH_RISK_THRESHOLD_USD } from "@/lib/payments/rules";
import { DEFAULT_MONTHLY_CHECKLISTS } from "@/lib/compliance/milestones";

/** Typed, defaulted settings stored in the `settings` collection. Admin → Settings edits these. */
export interface SettingsMap {
  "reminders.offsets": number[]; // days before due, 0 = due date
  "reminders.offsetsByTaskType": Record<string, number[]>;
  "reminders.holidays": string[]; // date-only, excluded from business-day escalation
  "reminders.emailEnabled": boolean;
  /** Candidate-facing reminder emails (separate template + log). OFF by default; only sent to candidates with an email. */
  "reminders.candidateEmailEnabled": boolean;
  "tracker.checklists": Record<number, string[]>;
  "tracker.autoNextCycle": boolean;
  "payments.highRiskThresholdUsd": number;
  "integrations.gusto": { route: "manual" | "cli" | "mcp" | "api"; companyRef?: string; webhookSecretSet?: boolean };
  "integrations.ria": { contractApproved: boolean; apiConfigured: boolean; notes?: string };
  "integrations.bank": { route: "manual" | "api"; notes?: string };
  "retention.policies": Record<string, { years: number; note?: string }>; // by record type; no hard-coded single period
  "emergencyPayroll.requireReviewer": boolean;
}

export const SETTING_DEFAULTS: SettingsMap = {
  "reminders.offsets": [...DEFAULT_OFFSETS],
  "reminders.offsetsByTaskType": {},
  "reminders.holidays": [],
  "reminders.emailEnabled": true,
  "reminders.candidateEmailEnabled": false,
  "tracker.checklists": DEFAULT_MONTHLY_CHECKLISTS,
  "tracker.autoNextCycle": false,
  "payments.highRiskThresholdUsd": DEFAULT_HIGH_RISK_THRESHOLD_USD,
  "integrations.gusto": { route: "manual" },
  "integrations.ria": { contractApproved: false, apiConfigured: false },
  "integrations.bank": { route: "manual" },
  "retention.policies": {
    payroll_records: { years: 3, note: "DOL FLSA: generally at least 3 years; confirm with counsel" },
    wage_computation: { years: 2, note: "DOL FLSA: generally at least 2 years; confirm with counsel" },
    immigration_documents: { years: 0, note: "Set by counsel — 0 means 'not yet defined; do not delete'" },
  },
  "emergencyPayroll.requireReviewer": true,
};

export async function getSetting<K extends keyof SettingsMap>(key: K): Promise<SettingsMap[K]> {
  await connectDb();
  const doc = await Setting.findById(key).lean<{ value: SettingsMap[K] }>();
  return (doc?.value ?? SETTING_DEFAULTS[key]) as SettingsMap[K];
}

export async function setSetting<K extends keyof SettingsMap>(key: K, value: SettingsMap[K], userId: string | null) {
  await connectDb();
  await Setting.updateOne({ _id: key }, { $set: { value, updatedBy: userId } }, { upsert: true });
}
