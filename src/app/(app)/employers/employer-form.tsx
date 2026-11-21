"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormAlert, Input, SubmitButton, Textarea } from "@/components/ui/form";
import type { ActionState } from "@/modules/immigration/action-utils";
import { createEmployerAction, updateEmployerAction } from "./actions";

export interface EmployerFormInitial {
  id?: string;
  legalName?: string;
  address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string };
  contacts?: { name?: string; title?: string; email?: string; phone?: string }[];
  isClientSite?: boolean;
  notes?: string;
}

const CONTACT_SLOTS = 3;

export function EmployerForm({ mode, initial, canIds }: { mode: "create" | "edit"; initial?: EmployerFormInitial; canIds: boolean }) {
  const [state, action] = useActionState<ActionState, FormData>(mode === "create" ? createEmployerAction : updateEmployerAction, {});
  const fe = state.fieldErrors ?? {};
  const a = initial?.address ?? {};
  const f = (name: string, label: string, def?: string, opts: { required?: boolean; type?: string; hint?: string } = {}) => (
    <Field label={label} htmlFor={name} error={fe[name]} required={opts.required} hint={opts.hint}>
      <Input id={name} name={name} type={opts.type ?? "text"} required={opts.required} defaultValue={def ?? ""} />
    </Field>
  );
  return (
    <form action={action} className="space-y-6">
      {mode === "edit" && <input type="hidden" name="id" value={initial?.id} />}
      <FormAlert error={state.error} />
      <Card>
        <CardHeader title="Employer" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          {f("legalName", "Legal name", initial?.legalName, { required: true })}
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="isClientSite" defaultChecked={initial?.isClientSite} /> Work is performed at a client site
          </label>
          {f("addressLine1", "Address line 1", a.line1)}
          {f("addressLine2", "Address line 2", a.line2)}
          {f("city", "City", a.city)}
          {f("state", "State", a.state)}
          {f("postalCode", "Postal code", a.postalCode)}
        </CardBody>
      </Card>

      {canIds && (
        <Card>
          <CardHeader title="Identifiers (restricted)" description="Stored encrypted; shown masked and revealed only through an audited action." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {f("ein", "EIN", "", { hint: mode === "edit" ? "Leave blank to keep the current value." : undefined })}
            {f("everifyCompanyId", "E-Verify company ID", "", { hint: mode === "edit" ? "Leave blank to keep the current value." : "Required for STEM OPT clearance." })}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Contacts" description={`Up to ${CONTACT_SLOTS} contacts (HR, supervisor, DSO liaison...).`} />
        <CardBody className="space-y-4">
          {Array.from({ length: CONTACT_SLOTS }, (_, i) => {
            const c = initial?.contacts?.[i];
            return (
              <div key={i} className="grid gap-3 sm:grid-cols-4">
                {f(`contact${i}Name`, `Contact ${i + 1} name`, c?.name)}
                {f(`contact${i}Title`, "Title", c?.title)}
                {f(`contact${i}Email`, "Email", c?.email, { type: "email" })}
                {f(`contact${i}Phone`, "Phone", c?.phone)}
              </div>
            );
          })}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <Field label="Notes" htmlFor="notes" error={fe.notes}>
            <Textarea id="notes" name="notes" defaultValue={initial?.notes ?? ""} maxLength={2000} />
          </Field>
        </CardBody>
      </Card>

      <div className="flex gap-2">
        <SubmitButton pendingText="Saving…">{mode === "create" ? "Create employer" : "Save changes"}</SubmitButton>
        <Button asChild variant="ghost">
          <Link href={mode === "edit" && initial?.id ? `/employers/${initial.id}` : "/employers"}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
