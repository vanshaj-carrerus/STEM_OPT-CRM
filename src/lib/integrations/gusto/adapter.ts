import type { PayrollStatus } from "@/lib/payroll/rules";
import { getSetting } from "@/lib/settings";

/**
 * Gusto adapter boundary. Gusto is the payroll system of record; the CRM only mirrors state.
 *
 * Gusto's App Integrations API is restricted to approved partners and employers are directed to its CLI/MCP route,
 * so the default `ManualGustoAdapter` performs NO network calls: payroll state is entered manually (with provider
 * evidence) or imported from a register CSV. A real adapter can be dropped in behind this interface once an access
 * route is confirmed (settings → integrations.gusto.route) — it must only report state it verified with the provider.
 */
export interface GustoPayrollSnapshot {
  externalRef: string; // Gusto payroll ID
  status: PayrollStatus;
  payPeriod?: { start: string; end: string; payDate?: string };
  processedAt?: Date | null;
  payStatementRef?: string | null;
  totals?: { grossCents: number; netCents: number };
}

export interface GustoAdapter {
  readonly name: string;
  /** True only when state returned by this adapter was fetched from Gusto itself (verified provider evidence). */
  readonly verifiedProvider: boolean;
  fetchPayrollStatus(externalRef: string): Promise<GustoPayrollSnapshot | null>;
  listPayrolls(period: { start: string; end: string }): Promise<GustoPayrollSnapshot[]>;
}

export class ManualGustoAdapter implements GustoAdapter {
  readonly name = "manual";
  readonly verifiedProvider = false;
  async fetchPayrollStatus(): Promise<GustoPayrollSnapshot | null> {
    return null; // no network: status is entered by a human with provider evidence, or arrives via signed webhook
  }
  async listPayrolls(): Promise<GustoPayrollSnapshot[]> {
    return [];
  }
}

let override: GustoAdapter | null = null;
/** Install a real adapter (or a test double). Pass null to restore the manual adapter. */
export function setGustoAdapter(a: GustoAdapter | null) {
  override = a;
}

export function getGustoAdapter(): GustoAdapter {
  return override ?? new ManualGustoAdapter();
}

export const GUSTO_ROUTE_LABELS: Record<"manual" | "cli" | "mcp" | "api", string> = {
  manual: "Manual / CSV tracking",
  cli: "Gusto CLI (not connected)",
  mcp: "Gusto MCP (not connected)",
  api: "Gusto API (partner access required)",
};

/** Current integration route from Admin → Settings, plus whether live sync is actually available. */
export async function gustoRoute() {
  const s = await getSetting("integrations.gusto");
  const adapter = getGustoAdapter();
  return { route: s.route, companyRef: s.companyRef, adapter: adapter.name, liveSync: adapter.verifiedProvider };
}
