import { Info } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { GUSTO_ROUTE_LABELS, gustoRoute } from "@/lib/integrations/gusto/adapter";

/** Explains the manual workflow until a Gusto access route is confirmed (Gusto is the system of record). */
export async function GustoBanner() {
  const r = await gustoRoute();
  return (
    <Card className="mb-5 border-info/30 bg-info-bg">
      <CardBody className="flex gap-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <div>
          <p className="font-medium text-info">Gusto is the payroll system of record · route: {GUSTO_ROUTE_LABELS[r.route]}</p>
          <p className="mt-1 text-muted-foreground">
            {r.liveSync
              ? "Live provider sync is connected; provider state is applied only through guarded status transitions."
              : "Gusto's App Integrations API is limited to approved partners, so this CRM does not call Gusto. Track payroll manually: prepare the batch, get a different person to approve it, run payroll in Gusto, then record the Gusto payroll ID and provider evidence (or import the register CSV) and reconcile against the settlement. Signed provider webhooks can update status automatically once configured."}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
