import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { SETTING_DEFAULTS, getSetting, type SettingsMap } from "@/lib/settings";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsForms } from "./settings-forms";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requirePage("admin.settings");
  const keys = Object.keys(SETTING_DEFAULTS) as (keyof SettingsMap)[];
  const entries = await Promise.all(keys.map(async (k) => [k, await getSetting(k)] as const));
  const s = Object.fromEntries(entries) as unknown as SettingsMap;
  return (
    <>
      <PageHeader title="Settings" description="Reminder rules, payment controls, integrations and retention policy. Every change is audit-logged." />
      <SettingsForms s={s} canEdit={can(user, "admin.settings")} canIntegrations={can(user, "admin.integrations")} />
    </>
  );
}
