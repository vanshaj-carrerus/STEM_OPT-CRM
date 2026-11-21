import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { listAssignableUsers } from "@/lib/users/directory";
import { PageHeader } from "@/components/layout/page-header";
import { CandidateForm } from "../candidate-form";

export const metadata: Metadata = { title: "New candidate" };

export default async function NewCandidatePage() {
  const user = await requirePage("candidates.create");
  const owners = await listAssignableUsers();
  return (
    <>
      <PageHeader title="New candidate" description="Create a candidate profile. Duplicates are checked by email, SEVIS ID and name + date of birth." />
      <CandidateForm
        mode="create"
        owners={owners}
        caps={{
          immigrationEdit: can(user, "immigration.edit"),
          sevis: can(user, "sensitive.sevis.view"),
          ead: can(user, "sensitive.ead.view"),
          dob: can(user, "sensitive.dob.view"),
          assign: can(user, "candidates.assign"),
        }}
      />
    </>
  );
}
