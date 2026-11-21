import type { MaterialChangeField } from "@/lib/tasks/triggers";

/** Pure detection of AC-06 material changes between two employment snapshots. */
export interface EmploymentSnapshot {
  employerId?: string | null;
  jobTitle?: string | null;
  jobDuties?: string | null;
  worksiteName?: string | null;
  worksiteAddress?: string | null;
  hoursPerWeek?: number | null;
  payTerms?: string | null;
}

const norm = (v: unknown) => (v == null ? "" : String(v).trim());

const RULES: { field: MaterialChangeField; keys: (keyof EmploymentSnapshot)[]; label: string }[] = [
  { field: "employer", keys: ["employerId"], label: "employer" },
  { field: "hours", keys: ["hoursPerWeek"], label: "hours per week" },
  { field: "compensation", keys: ["payTerms"], label: "compensation / pay terms" },
  { field: "jobDuties", keys: ["jobTitle", "jobDuties"], label: "job title / duties" },
  { field: "worksite", keys: ["worksiteName", "worksiteAddress"], label: "worksite" },
];

export function changedMaterialFields(before: EmploymentSnapshot, after: EmploymentSnapshot): { fields: MaterialChangeField[]; labels: string[] } {
  const fields: MaterialChangeField[] = [];
  const labels: string[] = [];
  for (const r of RULES) {
    if (r.keys.some((k) => norm(before[k]) !== norm(after[k]))) {
      fields.push(r.field);
      labels.push(r.label);
    }
  }
  return { fields, labels };
}
