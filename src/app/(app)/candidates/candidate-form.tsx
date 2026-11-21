"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormAlert, Input, Select, SubmitButton, Textarea } from "@/components/ui/form";
import { AUTH_TYPE_LABELS, CANDIDATE_STAGES, I983_STATUSES, STAGE_LABELS } from "@/lib/candidates/constants";
import { createCandidateAction, updateCandidateAction, type CandidateFormState } from "./actions";

type V = Record<string, unknown>;

export interface FormCaps {
  immigrationEdit: boolean;
  sevis: boolean;
  ead: boolean;
  dob: boolean;
  assign: boolean;
}

const s = (v: unknown) => (typeof v === "string" ? v : "");

export function CandidateForm({
  mode,
  initial,
  owners,
  caps,
}: {
  mode: "create" | "edit";
  initial?: V;
  owners: { id: string; name: string }[];
  caps: FormCaps;
}) {
  const [state, action] = useActionState<CandidateFormState, FormData>(
    mode === "create" ? createCandidateAction : updateCandidateAction,
    {},
  );
  const fe = state.fieldErrors ?? {};
  const v = initial ?? {};
  const addr = (v.address ?? {}) as V;
  const emer = (v.emergencyContact ?? {}) as V;
  const tags = Array.isArray(v.tags) ? (v.tags as string[]).join(", ") : "";
  const keepHint = mode === "edit" ? "Leave blank to keep the current value." : undefined;

  const f = (name: string, label: string, opts: { type?: string; required?: boolean; hint?: string; placeholder?: string; def?: string } = {}) => (
    <Field label={label} htmlFor={name} error={fe[name]} required={opts.required} hint={opts.hint}>
      <Input
        id={name}
        name={name}
        type={opts.type ?? "text"}
        required={opts.required}
        placeholder={opts.placeholder}
        defaultValue={opts.def ?? s(v[name])}
      />
    </Field>
  );

  return (
    <form action={action} className="space-y-6">
      {mode === "edit" && <input type="hidden" name="id" value={s(v._id)} />}
      <FormAlert error={state.error} />

      {state.duplicates && state.duplicates.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning-bg p-4 text-sm">
          <p className="mb-2 font-medium text-warning">
            {state.softDuplicate ? "Possible duplicate found" : "Duplicate candidate — cannot save"}
          </p>
          <ul className="space-y-1">
            {state.duplicates.map((d) => (
              <li key={d.id || d.reason}>
                {d.id ? (
                  <Link className="text-primary hover:underline" href={`/candidates/${d.id}`} target="_blank">
                    {d.code} · {d.name}
                  </Link>
                ) : (
                  <span>{d.name}</span>
                )}{" "}
                <span className="text-muted-foreground">
                  ({d.email ? `${d.email} — ` : ""}
                  {d.reason})
                </span>
              </li>
            ))}
          </ul>
          {state.softDuplicate && (
            <label className="mt-3 flex items-center gap-2">
              <input type="checkbox" name="allowSoftDuplicate" /> This is a different person — create anyway
            </label>
          )}
        </div>
      )}

      <Card>
        <CardHeader title="Identity & contact" />
        <CardBody className="grid gap-4 md:grid-cols-2">
          {f("legalName", "Legal name", { required: true })}
          {f("preferredName", "Preferred name")}
          {f("email", "Email", { type: "email", required: true })}
          {f("phone", "Phone")}
          {caps.dob && f("dateOfBirth", "Date of birth (restricted)", { type: "date", hint: keepHint })}
          {f("country", "Country of citizenship")}
          <Field label="Address line 1" htmlFor="addressLine1" error={fe.addressLine1}>
            <Input id="addressLine1" name="addressLine1" defaultValue={s(addr.line1)} />
          </Field>
          <Field label="Address line 2" htmlFor="addressLine2">
            <Input id="addressLine2" name="addressLine2" defaultValue={s(addr.line2)} />
          </Field>
          <Field label="City" htmlFor="city">
            <Input id="city" name="city" defaultValue={s(addr.city)} />
          </Field>
          <Field label="State" htmlFor="state">
            <Input id="state" name="state" defaultValue={s(addr.state)} />
          </Field>
          <Field label="ZIP / postal code" htmlFor="postalCode">
            <Input id="postalCode" name="postalCode" defaultValue={s(addr.postalCode)} />
          </Field>
          <Field label="Address country" htmlFor="addressCountry">
            <Input id="addressCountry" name="addressCountry" defaultValue={s(addr.country)} />
          </Field>
          <Field label="Emergency contact name" htmlFor="emergencyName">
            <Input id="emergencyName" name="emergencyName" defaultValue={s(emer.name)} />
          </Field>
          <Field label="Emergency contact phone" htmlFor="emergencyPhone">
            <Input id="emergencyPhone" name="emergencyPhone" defaultValue={s(emer.phone)} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Education" description="School, degree and designated school official (DSO) contact." />
        <CardBody className="grid gap-4 md:grid-cols-2">
          {f("school", "School / university")}
          {f("campus", "Campus")}
          {f("degreeLevel", "Degree level", { placeholder: "e.g. Master's" })}
          {f("degree", "Degree")}
          {f("major", "Major")}
          {f("stemCipCode", "STEM CIP code", { placeholder: "e.g. 11.0701" })}
          {f("programStart", "Program start", { type: "date" })}
          {f("programEnd", "Program end", { type: "date" })}
          {f("graduationDate", "Graduation date", { type: "date" })}
          {f("dsoName", "DSO name")}
          {f("dsoEmail", "DSO email", { type: "email" })}
          {f("dsoPhone", "DSO phone")}
        </CardBody>
      </Card>

      {caps.immigrationEdit && (
        <Card>
          <CardHeader
            title="Immigration"
            description="Dates and identifiers only. The CRM records evidence — it does not decide eligibility. Clearance to work is set in the Immigration tab after evidence is verified."
          />
          <CardBody className="grid gap-4 md:grid-cols-2">
            <Field label="Authorization type" htmlFor="authType">
              <Select id="authType" name="authType" defaultValue={s(v.authType) || "none"}>
                {Object.entries(AUTH_TYPE_LABELS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            {f("visaStatus", "Visa / status category", { placeholder: "F-1" })}
            {caps.sevis && f("sevisId", "SEVIS ID (restricted)", { hint: keepHint })}
            {caps.ead && f("eadNumber", "EAD number (restricted)", { hint: keepHint })}
            {f("eadCategory", "EAD category", { placeholder: "C03B / C03C" })}
            {f("receiptNumber", "Receipt number")}
            {f("eadStart", "EAD start", { type: "date" })}
            {f("eadEnd", "EAD end", { type: "date" })}
            {f("i20IssueDate", "I-20 issue date", { type: "date" })}
            {f("i20EndorsementDate", "I-20 endorsement date", { type: "date" })}
            <Field label="I-983 status" htmlFor="i983Status">
              <Select id="i983Status" name="i983Status" defaultValue={s(v.i983Status) || "not_applicable"}>
                {I983_STATUSES.map((k) => (
                  <option key={k} value={k}>
                    {k.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
            </Field>
            {f("caseStatus", "Case status")}
            {f("validationStatus", "Validation status")}
            {f("reviewOutcome", "Review outcome")}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="CRM" />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label="Stage" htmlFor="stage">
            <Select id="stage" name="stage" defaultValue={s(v.stage) || "new"}>
              {CANDIDATE_STAGES.map((k) => (
                <option key={k} value={k}>
                  {STAGE_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority" htmlFor="priority">
            <Select id="priority" name="priority" defaultValue={s(v.priority) || "normal"}>
              {["low", "normal", "high", "urgent"].map((k) => (
                <option key={k} value={k}>
                  {k[0].toUpperCase() + k.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          {caps.assign && (
            <Field label="Assigned compliance owner" htmlFor="ownerId">
              <Select id="ownerId" name="ownerId" defaultValue={s(v.ownerId)}>
                <option value="">{mode === "create" ? "— me —" : "— unassigned —"}</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {caps.assign && (
            <Field label="Recruiter" htmlFor="recruiterId">
              <Select id="recruiterId" name="recruiterId" defaultValue={s(v.recruiterId)}>
                <option value="">— none —</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {f("source", "Lead / source")}
          <Field label="Tags" htmlFor="tagsCsv" hint="Comma-separated" className="md:col-span-2">
            <Textarea id="tagsCsv" name="tagsCsv" rows={2} defaultValue={tags} />
          </Field>
        </CardBody>
      </Card>

      <div className="flex justify-end gap-2">
        <Button asChild variant="outline">
          <Link href={mode === "edit" ? `/candidates/${s(v._id)}` : "/candidates"}>Cancel</Link>
        </Button>
        <SubmitButton pendingText="Saving…">{mode === "create" ? "Create candidate" : "Save changes"}</SubmitButton>
      </div>
    </form>
  );
}
