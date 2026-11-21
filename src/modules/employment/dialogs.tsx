"use client";

import { Pencil, Plus } from "lucide-react";
import type { EmploymentView } from "@/lib/employment/service";
import { FormDialog, SelectField, TextAreaField, TextField } from "../immigration/form-dialog";
import { endEmploymentAction, saveEmploymentAction } from "./actions";

export function EmploymentDialog({
  candidateId, employers, record, canPay, hasCurrent,
}: {
  candidateId: string;
  employers: { id: string; name: string }[];
  record?: EmploymentView;
  canPay: boolean;
  hasCurrent: boolean;
}) {
  const edit = !!record;
  return (
    <FormDialog
      wide
      title={edit ? "Edit employment record" : "Add employment record"}
      description="Changes to employer, hours, compensation, job duties or worksite raise a review task (no automatic legal conclusion). Employment records never grant clearance to work."
      triggerLabel={edit ? "Edit" : "Add employment"}
      triggerIcon={edit ? <Pencil className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />}
      triggerVariant={edit ? "ghost" : "outline"}
      action={saveEmploymentAction}
      hidden={{ candidateId, ...(record ? { recordId: record.id } : {}) }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="employerId" label="Employer" required defaultValue={record?.employerId}
          options={[{ value: "", label: "Choose employer…" }, ...employers.map((e) => ({ value: e.id, label: e.name }))]}
          hint="Not listed? Add it under Employers first."
        />
        <TextField name="jobTitle" label="Job title" defaultValue={record?.jobTitle} />
        <TextField name="startDate" label="Start date" type="date" defaultValue={record?.startDate} />
        <TextField name="endDate" label="End date" type="date" defaultValue={record?.endDate} hint="Blank while employment is active" />
        <TextField name="hoursPerWeek" label="Hours per week" type="number" defaultValue={record?.hoursPerWeek} hint="STEM OPT requires at least 20" />
        {canPay && <TextField name="payTerms" label="Pay terms (restricted)" defaultValue={record?.payTerms} />}
        <TextField name="supervisorName" label="Supervisor name" defaultValue={record?.supervisor?.name} />
        <TextField name="supervisorEmail" label="Supervisor email" type="email" defaultValue={record?.supervisor?.email} />
        <TextField name="supervisorPhone" label="Supervisor phone" defaultValue={record?.supervisor?.phone} />
        <TextField name="worksiteName" label="Worksite name" defaultValue={record?.worksiteName} />
        <TextField name="worksiteAddress" label="Worksite address" defaultValue={record?.worksiteAddress} className="sm:col-span-2" />
        <SelectField
          name="relatedToDegree" label="Related to degree?" defaultValue={record?.relatedToDegree ?? "needs_review"}
          options={[{ value: "needs_review", label: "Needs review" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
        />
      </div>
      <TextAreaField name="jobDuties" label="Job duties" defaultValue={record?.jobDuties} rows={3} maxLength={4000} />
      <TextAreaField name="relationReviewNote" label="Relation-to-degree review note" defaultValue={record?.relationReviewNote} rows={2} maxLength={1000} />
      {(!record || record.status === "active") && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="setAsCurrent" defaultChecked={record ? record.isCurrent : !hasCurrent} /> Set as the candidate&apos;s current employer
        </label>
      )}
    </FormDialog>
  );
}

export function EndEmploymentDialog({ candidateId, recordId, today }: { candidateId: string; recordId: string; today: string }) {
  return (
    <FormDialog
      title="End employment"
      description="Marks the record as ended and raises a review task. Clearance tied to this employment is re-checked and revoked if it no longer holds."
      triggerLabel="End"
      triggerVariant="ghost"
      action={endEmploymentAction}
      hidden={{ candidateId, recordId }}
      submitLabel="End employment"
      submitVariant="danger"
    >
      <TextField name="endDate" label="Last day of employment" type="date" required defaultValue={today} />
    </FormDialog>
  );
}
