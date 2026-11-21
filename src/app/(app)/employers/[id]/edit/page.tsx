import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { getEmployer } from "@/lib/employers/service";
import { PageHeader } from "@/components/layout/page-header";
import { EmployerForm } from "../../employer-form";

export const metadata: Metadata = { title: "Edit employer" };

export default async function EditEmployerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePage("immigration.edit");
  const e = await getEmployer(user, id);
  if (!e) notFound();
  return (
    <>
      <PageHeader title={`Edit ${e.legalName}`} />
      <EmployerForm
        mode="edit"
        canIds={can(user, "sensitive.employerIds.view")}
        initial={{ id, legalName: e.legalName, address: e.address, contacts: e.contacts, isClientSite: e.isClientSite, notes: e.notes }}
      />
    </>
  );
}
