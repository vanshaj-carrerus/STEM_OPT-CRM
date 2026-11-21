"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAction } from "@/lib/auth/guard";
import { getSetting, setSetting, type SettingsMap } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { isDateOnly } from "@/lib/compliance/dates";

export interface SettingsState {
  error?: string;
  ok?: boolean;
}

async function save<K extends keyof SettingsMap>(
  actorPerm: "admin.settings" | "admin.integrations",
  key: K,
  build: (prev: SettingsMap[K]) => SettingsMap[K],
  summary: string,
): Promise<SettingsState> {
  const actor = await requireAction(actorPerm);
  const before = await getSetting(key);
  const after = build(before);
  await setSetting(key, after, actor.id);
  await audit({ actor, action: "update", entityType: "setting", entityId: key, summary, before, after });
  revalidatePath("/admin/settings");
  return { ok: true };
}

const offsetsSchema = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean).map(Number))
  .pipe(z.array(z.number().int().min(0).max(365)).min(1).max(12));

export async function saveReminderSettings(_p: SettingsState, fd: FormData): Promise<SettingsState> {
  await requireAction("admin.settings");
  const offsets = offsetsSchema.safeParse(fd.get("offsets"));
  if (!offsets.success) return { error: "Offsets must be whole numbers 0–365, comma-separated (e.g. 30, 14, 7, 3, 1, 0)." };
  const holidays = String(fd.get("holidays") ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (holidays.some((h) => !isDateOnly(h))) return { error: "Holidays must be dates in YYYY-MM-DD format." };
  const uniqueOffsets = [...new Set(offsets.data)].sort((a, b) => b - a);
  await save("admin.settings", "reminders.offsets", () => uniqueOffsets, "Updated default reminder offsets");
  await save("admin.settings", "reminders.holidays", () => [...new Set(holidays)].sort(), "Updated holiday calendar");
  return save("admin.settings", "reminders.emailEnabled", () => fd.get("emailEnabled") === "on", "Updated reminder email toggle");
}

export async function saveTrackerSettings(_p: SettingsState, fd: FormData): Promise<SettingsState> {
  return save("admin.settings", "tracker.autoNextCycle", () => fd.get("autoNextCycle") === "on", "Updated 12-month tracker auto-next-cycle");
}

export async function savePaymentSettings(_p: SettingsState, fd: FormData): Promise<SettingsState> {
  const n = z.coerce.number().positive().max(10_000_000).safeParse(fd.get("threshold"));
  if (!n.success) return { error: "Enter a positive amount in USD." };
  return save("admin.settings", "payments.highRiskThresholdUsd", () => n.data, "Updated high-risk payment threshold");
}

export async function saveIntegrationSettings(_p: SettingsState, fd: FormData): Promise<SettingsState> {
  const gustoRoute = z.enum(["manual", "cli", "mcp", "api"]).safeParse(fd.get("gustoRoute"));
  const bankRoute = z.enum(["manual", "api"]).safeParse(fd.get("bankRoute"));
  if (!gustoRoute.success || !bankRoute.success) return { error: "Invalid integration route." };
  const notes = String(fd.get("riaNotes") ?? "").slice(0, 500);
  await save("admin.integrations", "integrations.gusto", (p) => ({ ...p, route: gustoRoute.data, companyRef: String(fd.get("gustoCompanyRef") ?? "").trim() || undefined }), "Updated Gusto integration route");
  await save("admin.integrations", "integrations.bank", (p) => ({ ...p, route: bankRoute.data }), "Updated bank workflow route");
  return save(
    "admin.integrations",
    "integrations.ria",
    () => ({ contractApproved: fd.get("riaContractApproved") === "on", apiConfigured: fd.get("riaApiConfigured") === "on", notes: notes || undefined }),
    "Updated Ria integration gates",
  );
}

export async function saveRetentionSettings(_p: SettingsState, fd: FormData): Promise<SettingsState> {
  const keys = fd.getAll("key").map(String);
  const years = fd.getAll("years").map(Number);
  const notes = fd.getAll("note").map(String);
  const out: SettingsMap["retention.policies"] = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i].trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!k) continue;
    if (!Number.isFinite(years[i]) || years[i] < 0 || years[i] > 100) return { error: `Retention years for "${k}" must be 0–100.` };
    out[k] = { years: Math.floor(years[i]), note: notes[i]?.slice(0, 300) || undefined };
  }
  return save("admin.settings", "retention.policies", () => out, "Updated retention policy table (configuration only; nothing is auto-deleted)");
}
