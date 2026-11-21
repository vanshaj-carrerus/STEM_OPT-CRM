"use client";

import { Pencil, Plus } from "lucide-react";
import { DOCUMENT_TYPE_MAP } from "@/lib/documents/types";
import type { EvidenceDocInfo } from "@/lib/immigration/evidence";
import type { I983View, PeriodView } from "@/lib/immigration/overview";
import {
  addUnemploymentAction, revokeClearanceAction, saveI983Action, savePeriodAction, unverifyPeriodAction,
} from "./actions";
import { FormDialog, SelectField, TextAreaField, TextField } from "./form-dialog";

const docLabel = (d: Pick<EvidenceDocInfo, "type" | "title" | "fileName" | "version" | "verification">) =>
  `${DOCUMENT_TYPE_MAP[d.type]?.label ?? d.type} — ${d.title || d.fileName} (v${d.version}, ${d.verification.replace("_", " ")})`;

function evidenceOptions(options: EvidenceDocInfo[], current?: string | null, currentDoc?: PeriodView["evidence"]) {
  const list = options.map((d) => ({ value: d.id, label: docLabel(d) }));
  if (current && !list.some((o) => o.value === current)) {
    list.unshift({ value: current, label: currentDoc ? docLabel(currentDoc) : "Currently attached document" });
  }
  return [{ value: "", label: "No evidence attached" }, ...list];
}

const I983_LABELS: Record<string, string> = {
  not_started: "Not started", draft: "Draft", awaiting_signatures: "Awaiting signatures",
  signed: "Signed", submitted_to_dso: "Submitted to DSO", needs_update: "Needs update",
};

export function PeriodDialog({
  candidateId, employers, evidence, period, defaultEducationLevel,
}: {
  candidateId: string;
  employers: { id: string; name: string }[];
  evidence: EvidenceDocInfo[];
  period?: PeriodView;
  defaultEducationLevel?: string;
}) {
  const edit = !!period;
  return (
    <FormDialog
      wide
      title={edit ? "Edit authorization period" : "Add authorization period"}
      description={
        edit && period?.verification === "verified"
          ? "This period is verified. Changing its dates, type, employer or evidence resets the verification, cancels derived milestones and revokes clearance."
          : "Record the exact approved dates from the official document (endorsed I-20 for CPT, EAD card for OPT / STEM OPT). Dates stay unverified until a reviewer verifies them against verified evidence."
      }
      triggerLabel={edit ? "Edit" : "Add period"}
      triggerIcon={edit ? <Pencil className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />}
      triggerVariant={edit ? "ghost" : "outline"}
      action={savePeriodAction}
      hidden={{ candidateId, ...(period ? { periodId: period.id } : {}) }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="type" label="Type" required defaultValue={period?.type ?? "CPT"}
          options={[{ value: "CPT", label: "CPT (employer-specific segment)" }, { value: "OPT", label: "Post-completion OPT" }, { value: "STEM_OPT", label: "STEM OPT extension (24 months)" }]}
        />
        <TextField name="category" label="EAD category" defaultValue={period?.category} placeholder="e.g. C03B / C03C" hint="OPT / STEM OPT only" />
        <TextField name="startDate" label="Authorized start date" type="date" required defaultValue={period?.startDate} />
        <TextField name="endDate" label="Authorized end date" type="date" required defaultValue={period?.endDate} />
        <SelectField
          name="employerId" label="Employer" defaultValue={period?.employerId}
          hint="Required for CPT. Optional for OPT / STEM OPT (STEM OPT is employer-specific; E-Verify details come from this employer)."
          options={[{ value: "", label: "— none —" }, ...employers.map((e) => ({ value: e.id, label: e.name }))]}
        />
        <SelectField
          name="workTime" label="CPT: full-time / part-time" defaultValue={period?.type === "CPT" ? (period.fullTime ? "full" : "part") : ""}
          hint="Required for CPT. 12+ months cumulative full-time CPT at one education level is flagged for DSO/legal review."
          options={[{ value: "", label: "—" }, { value: "full", label: "Full-time" }, { value: "part", label: "Part-time" }]}
        />
        <TextField name="educationLevel" label="Education level" defaultValue={period?.educationLevel ?? defaultEducationLevel} placeholder="e.g. Master's" hint="Used to total full-time CPT per level" />
        <SelectField
          name="evidenceDocumentId" label="Evidence document" defaultValue={period?.evidenceDocumentId}
          hint="Must be verified in the Documents tab before the dates can be verified."
          options={evidenceOptions(evidence, period?.evidenceDocumentId, period?.evidence)}
        />
      </div>
      <TextAreaField name="notes" label="Notes" defaultValue={period?.notes} rows={2} maxLength={2000} />
    </FormDialog>
  );
}

export function UnverifyDialog({ candidateId, periodId }: { candidateId: string; periodId: string }) {
  return (
    <FormDialog
      title="Un-verify or reject period"
      description="Derived milestones are cancelled (completed history is kept) and any clearance relying on this period is revoked. A reason is recorded in the audit log."
      triggerLabel="Un-verify"
      triggerVariant="ghost"
      action={unverifyPeriodAction}
      hidden={{ candidateId, periodId }}
      submitLabel="Confirm"
      submitVariant="danger"
    >
      <SelectField name="as" label="Outcome" defaultValue="unverified" options={[{ value: "unverified", label: "Back to unverified" }, { value: "rejected", label: "Rejected (dates/evidence not acceptable)" }]} />
      <TextAreaField name="reason" label="Reason" required rows={2} maxLength={500} />
    </FormDialog>
  );
}

export function I983Dialog({
  candidateId, period, evidence,
}: {
  candidateId: string;
  period: PeriodView;
  evidence: EvidenceDocInfo[];
}) {
  const r: I983View | null | undefined = period.i983;
  return (
    <FormDialog
      wide
      title="Form I-983 details"
      description="Track the training plan version and signatures. Changing the plan or version raises a review task; editing a verified I-983 resets its verification."
      triggerLabel={r ? "Edit I-983" : "Record I-983"}
      triggerIcon={r ? <Pencil className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />}
      action={saveI983Action}
      hidden={{ candidateId, periodId: period.id }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="status" label="Status" required defaultValue={r?.status ?? "not_started"} options={Object.entries(I983_LABELS).map(([value, label]) => ({ value, label }))} />
        <TextField name="formVersion" label="Form version / edition" defaultValue={r?.formVersion} placeholder="Edition date printed on the form" />
        <TextField name="studentSignedOn" label="Student signed on" type="date" defaultValue={r?.studentSignedOn} />
        <TextField name="employerSignedOn" label="Employer signed on" type="date" defaultValue={r?.employerSignedOn} />
        <TextField name="dsoSubmittedOn" label="Submitted to DSO on" type="date" defaultValue={r?.dsoSubmittedOn} hint="Recorded by staff. The CRM never submits anything to the DSO." />
        <SelectField
          name="evidenceDocumentId" label="I-983 document" defaultValue={r?.evidenceDocumentId}
          options={evidenceOptions(evidence, r?.evidenceDocumentId)}
        />
      </div>
      <TextAreaField name="trainingPlanSummary" label="Training plan summary" defaultValue={r?.trainingPlanSummary} rows={3} maxLength={4000} />
    </FormDialog>
  );
}

export function UnemploymentDialog({ candidateId }: { candidateId: string }) {
  return (
    <FormDialog
      title="Record unemployment period"
      description="Manual entry only; nothing is inferred from payroll. Leave the end date blank if the period is ongoing."
      triggerLabel="Add period"
      triggerIcon={<Plus className="h-4 w-4" />}
      action={addUnemploymentAction}
      hidden={{ candidateId }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="startDate" label="First day" type="date" required />
        <TextField name="endDate" label="Last day" type="date" hint="Blank = ongoing" />
      </div>
      <TextAreaField name="notes" label="Notes / source" rows={2} maxLength={1000} />
    </FormDialog>
  );
}

export function RevokeDialog({ candidateId }: { candidateId: string }) {
  return (
    <FormDialog
      title="Revoke clearance to work"
      description="Use when work should not proceed. The reason is recorded in the audit log."
      triggerLabel="Revoke clearance"
      triggerVariant="outline"
      action={revokeClearanceAction}
      hidden={{ candidateId }}
      submitLabel="Revoke"
      submitVariant="danger"
    >
      <TextAreaField name="reason" label="Reason" required rows={2} maxLength={500} />
    </FormDialog>
  );
}
