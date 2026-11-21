import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadCandidateFor, requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { toCandidateView } from "@/lib/candidates/service";
import { listAssignableUsers } from "@/lib/users/directory";
import { PageHeader } from "@/components/layout/page-header";
import { CandidateForm } from "../../candidate-form";

export const metadata: Metadata = { title: "Edit candidate" };

export default async function EditCandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePage("candidates.edit");
  const c = await loadCandidateFor(user, id);
  if (!c) notFound();
  const owners = await listAssignableUsers();
  const view = toCandidateView(user, c);
  // protected identifiers are blanked in the form (leave empty to keep); never send masks as values
  delete (view as Record<string, unknown>).sevisId;
  delete (view as Record<string, unknown>).eadNumber;
  delete (view as Record<string, unknown>).dateOfBirth;
  return (
    <>
      <PageHeader title={`Edit ${c.legalName}`} description={c.candidateCode} />
      <CandidateForm
        mode="edit"
        initial={view as Record<string, unknown>}
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
