import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/rbac/can";
import { getEmployer } from "@/lib/employers/service";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmployerSensitiveField } from "../employer-sensitive-field";

export const metadata: Metadata = { title: "Employer" };

function Item({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

export default async function EmployerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePage("candidates.view");
  const e = await getEmployer(user, id);
  if (!e) notFound();
  const a = e.address;
  const address = [a?.line1, a?.line2, [a?.city, a?.state, a?.postalCode].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  const seeIds = can(user, "sensitive.employerIds.view");

  return (
    <>
      <PageHeader
        title={e.legalName}
        description={e.isClientSite ? "Client site" : "Employer"}
        actions={
          can(user, "immigration.edit") ? (
            <Button asChild variant="outline">
              <Link href={`/employers/${id}/edit`}>
                <Pencil className="h-4 w-4" /> Edit
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Item label="Legal name">{e.legalName}</Item>
              <Item label="Address">{address}</Item>
              <Item label="Type">{e.isClientSite ? <Badge tone="info">Client site</Badge> : <Badge tone="neutral">Direct employer</Badge>}</Item>
              {seeIds ? (
                <>
                  <Item label="EIN">
                    <EmployerSensitiveField employerId={id} field="ein" mask={e.einMask} />
                  </Item>
                  <Item label="E-Verify company ID">
                    <EmployerSensitiveField employerId={id} field="everifyCompanyId" mask={e.everifyMask} />
                  </Item>
                </>
              ) : (
                <Item label="E-Verify company ID">{e.hasEverify ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Missing</Badge>}</Item>
              )}
              {e.notes && <Item label="Notes">{<span className="whitespace-pre-wrap">{e.notes}</span>}</Item>}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Contacts" />
          <CardBody>
            {e.contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No contacts recorded.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {e.contacts.map((c, i) => (
                  <li key={i}>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">{[c.title, c.email, c.phone].filter(Boolean).join(" · ")}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
