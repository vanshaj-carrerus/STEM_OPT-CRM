import type { Metadata } from "next";
import { requirePage } from "@/lib/auth/guard";
import { getSetting } from "@/lib/settings";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/form";
import { ActionForm } from "@/modules/payroll/components/action-form";
import { createBatchAction } from "../actions";

export const metadata: Metadata = { title: "New payroll batch" };

export default async function NewBatchPage() {
  await requirePage("payroll.prepare");
  const gusto = await getSetting("integrations.gusto");
  return (
    <>
      <PageHeader title="New payroll batch" description="Create a draft batch for a pay period. You will be recorded as the preparer and cannot approve it." />
      <Card className="max-w-2xl">
        <CardBody>
          <ActionForm action={createBatchAction} submit="Create draft batch" pendingText="Creating…">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Period start" htmlFor="start" required>
                <Input id="start" name="start" type="date" required />
              </Field>
              <Field label="Period end" htmlFor="end" required>
                <Input id="end" name="end" type="date" required />
              </Field>
              <Field label="Pay date" htmlFor="payDate" required>
                <Input id="payDate" name="payDate" type="date" required />
              </Field>
            </div>
            <Field label="Gusto company reference" htmlFor="companyRef" hint="Leave blank to use the company configured in settings.">
              <Input id="companyRef" name="companyRef" defaultValue={gusto.companyRef ?? ""} maxLength={64} />
            </Field>
            <Field label="Notes" htmlFor="notes">
              <Textarea id="notes" name="notes" rows={2} maxLength={1000} />
            </Field>
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}
