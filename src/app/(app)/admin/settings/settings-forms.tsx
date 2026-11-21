"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormAlert, Input, Select, SubmitButton, Textarea } from "@/components/ui/form";
import type { SettingsMap } from "@/lib/settings";
import {
  saveIntegrationSettings,
  savePaymentSettings,
  saveReminderSettings,
  saveRetentionSettings,
  saveTrackerSettings,
  type SettingsState,
} from "./actions";

type Act = (p: SettingsState, fd: FormData) => Promise<SettingsState>;

function Section({ title, description, action, children, canEdit = true }: { title: string; description?: string; action: Act; children: React.ReactNode; canEdit?: boolean }) {
  const [state, run] = useActionState<SettingsState, FormData>(action, {});
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody>
        <form action={run} className="space-y-4">
          <FormAlert error={state.error} message={state.ok ? "Saved." : undefined} />
          <fieldset disabled={!canEdit} className="space-y-4 disabled:opacity-70">
            {children}
          </fieldset>
          {canEdit && <SubmitButton size="sm">Save</SubmitButton>}
        </form>
      </CardBody>
    </Card>
  );
}

export function SettingsForms({ s, canEdit, canIntegrations }: { s: SettingsMap; canEdit: boolean; canIntegrations: boolean }) {
  const [rows, setRows] = useState(Object.entries(s["retention.policies"]).map(([key, v]) => ({ key, years: v.years, note: v.note ?? "" })));

  return (
    <div className="space-y-5">
      <Section
        title="Reminders & escalation"
        description="Internal reminders go out on these day offsets before each due date, plus the due date itself. Overdue tasks escalate: owner → team lead (1 business day) → compliance manager (3) → admin (5). Holidays are skipped when counting business days."
        action={saveReminderSettings}
        canEdit={canEdit}
      >
        <Field label="Reminder offsets (days before due; 0 = due date)" htmlFor="offsets">
          <Input id="offsets" name="offsets" defaultValue={s["reminders.offsets"].join(", ")} />
        </Field>
        <Field label="Holidays (YYYY-MM-DD, separated by commas or spaces)" htmlFor="holidays">
          <Textarea id="holidays" name="holidays" rows={2} defaultValue={s["reminders.holidays"].join(", ")} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="emailEnabled" defaultChecked={s["reminders.emailEnabled"]} /> Send reminder emails (in-app notifications are always on)
        </label>
      </Section>

      <Section title="12-month tracker" description="Month 1–12 operational reviews. This internal cadence does not replace official DSO reporting." action={saveTrackerSettings} canEdit={canEdit}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="autoNextCycle" defaultChecked={s["tracker.autoNextCycle"]} /> Automatically start the next cycle after a manager signs off month 12
        </label>
      </Section>

      <Section title="Payments" description="High-risk payments (large amounts, international wires, new/changed recipients) require two different approvers." action={savePaymentSettings} canEdit={canEdit}>
        <Field label="High-risk threshold (USD equivalent)" htmlFor="threshold">
          <Input id="threshold" name="threshold" type="number" min={1} step="1" defaultValue={s["payments.highRiskThresholdUsd"]} className="w-48" />
        </Field>
      </Section>

      <Section
        title="Integrations"
        description="Automation stays off until each provider's access and approved use are confirmed. The manual tracking workflow is always available."
        action={saveIntegrationSettings}
        canEdit={canIntegrations}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Gusto integration route" htmlFor="gustoRoute" hint="Gusto's App Integrations API is limited to approved partners; employers are directed to its CLI / MCP server. Confirm your account permissions.">
            <Select id="gustoRoute" name="gustoRoute" defaultValue={s["integrations.gusto"].route}>
              <option value="manual">Manual tracking / CSV import</option>
              <option value="cli">Gusto CLI</option>
              <option value="mcp">Gusto MCP server</option>
              <option value="api">Direct API (approved partner)</option>
            </Select>
          </Field>
          <Field label="Gusto company reference" htmlFor="gustoCompanyRef">
            <Input id="gustoCompanyRef" name="gustoCompanyRef" defaultValue={s["integrations.gusto"].companyRef ?? ""} />
          </Field>
          <Field label="Bank wire workflow" htmlFor="bankRoute">
            <Select id="bankRoute" name="bankRoute" defaultValue={s["integrations.bank"].route}>
              <option value="manual">Manual — operator initiates in the bank&apos;s approved channel</option>
              <option value="api">Bank API (when approved)</option>
            </Select>
          </Field>
        </div>
        <div className="space-y-2 rounded-md border bg-muted/40 p-4">
          <p className="text-sm font-medium">Ria Money Transfer</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="riaContractApproved" defaultChecked={s["integrations.ria"].contractApproved} />
            Ria has approved our business use case <em>in writing</em> (including wage/payroll-type disbursement, if applicable)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="riaApiConfigured" defaultChecked={s["integrations.ria"].apiConfigured} /> API credentials / sandbox configured
          </label>
          <Field label="Reference / notes (contract ID, approval email date…)" htmlFor="riaNotes">
            <Input id="riaNotes" name="riaNotes" defaultValue={s["integrations.ria"].notes ?? ""} />
          </Field>
          <p className="text-xs text-muted-foreground">Automated transfers are enabled only when BOTH boxes are ticked.</p>
        </div>
      </Section>

      <Section
        title="Retention policy"
        description="Records the retention period per record type. Requirements vary by record type and law (e.g. DOL generally 3 years payroll / 2 years wage computation) — confirm with counsel. Nothing is ever deleted automatically; 0 means 'not yet defined'."
        action={saveRetentionSettings}
        canEdit={canEdit}
      >
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <Input name="key" defaultValue={r.key} className="col-span-4" aria-label="Record type" />
              <Input name="years" type="number" min={0} max={100} defaultValue={r.years} className="col-span-2" aria-label="Years" />
              <Input name="note" defaultValue={r.note} className="col-span-6" aria-label="Note" />
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={() => setRows([...rows, { key: "", years: 0, note: "" }])}>
            <Plus className="h-3.5 w-3.5" /> Add record type
          </Button>
        </div>
      </Section>
    </div>
  );
}
