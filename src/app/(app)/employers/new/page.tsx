import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { PageHeader } from "@/components/layout/page-header";
import { EmployerForm } from "../employer-form";

export const metadata: Metadata = { title: "New employer" };

export default async function NewEmployerPage() {
  const user = await requirePage("immigration.edit");
  return (
    <>
      <PageHeader title="New employer" description="Legal name, address, contacts and (restricted) EIN / E-Verify company ID." />
      <EmployerForm mode="create" canIds={can(user, "sensitive.employerIds.view")} />
    </>
  );
}
