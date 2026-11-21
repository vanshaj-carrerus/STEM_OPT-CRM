import type { Metadata } from "next";
import Link from "next/link";
import { requirePage } from "@/lib/auth/guard";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "Import candidates" };

export default async function ImportCandidatesPage() {
  await requirePage("candidates.import"); // the API additionally requires candidates.create
  return (
    <>
      <PageHeader
        title="Import candidates"
        description="Upload the approved master roster, check the field mapping, invalid rows and duplicates, then confirm."
        actions={
          <Button asChild variant="outline">
            <Link href="/candidates">Back to candidates</Link>
          </Button>
        }
      />
      <ImportWizard />
    </>
  );
}
