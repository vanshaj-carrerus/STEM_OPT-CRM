import { Info } from "lucide-react";
import { riaAutomationEnabled, RIA_DISABLED_BANNER } from "@/lib/payments/automation";

/** Shown on every Ria/wire area while Ria automation is not approved (driven by Admin → Settings → integrations.ria). */
export async function RiaBanner() {
  if (await riaAutomationEnabled()) return null;
  return (
    <div role="note" className="mb-5 flex items-start gap-2 rounded-md border border-info/30 bg-info-bg px-4 py-3 text-sm text-info">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{RIA_DISABLED_BANNER}</p>
    </div>
  );
}
