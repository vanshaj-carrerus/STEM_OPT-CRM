import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/rbac/can";
import type { SessionUser } from "@/lib/auth/session";
import { isDateOnly } from "@/lib/compliance/dates";
import { PayrollBatch, type IPayrollBatch } from "@/lib/db/models/payroll-batch";
import { getGustoAdapter, gustoRoute, type GustoPayrollSnapshot } from "@/lib/integrations/gusto/adapter";
import { applyTransition, loadBatch } from "./batches";
import { planWebhookTransitions } from "./webhook-map";
import { logSync } from "./sync-log";

/**
 * Manual "sync" workflow. With the default ManualGustoAdapter no network call is made and nothing is changed: the
 * sync log records that state must be entered manually / imported from CSV. A verified-provider adapter may apply
 * state, but only through the same guarded transitions as the webhook.
 */
export const syncSchema = z
  .object({
    batchId: z.string().min(1).optional(),
    period: z.object({ start: z.string().refine(isDateOnly), end: z.string().refine(isDateOnly) }).optional(),
  })
  .refine((v) => v.batchId || v.period, { message: "Provide a batchId or a pay period." });

export interface SyncSummary {
  adapter: string;
  route: string;
  liveSync: boolean;
  checked: number;
  applied: number;
  messages: string[];
}

async function applySnapshot(actor: SessionUser, batch: IPayrollBatch, snap: GustoPayrollSnapshot, summary: SyncSummary) {
  const plan = planWebhookTransitions(batch.status, snap.status);
  if (plan.action === "noop") return;
  if (plan.action === "reject") {
    summary.messages.push(`Batch ${batch._id}: provider reports ${snap.status} but ${plan.reason}`);
    await logSync({ kind: "sync", level: "warn", batchId: batch._id, actorId: actor.id, source: "api", message: `Provider state not applied: ${plan.reason}` });
    return;
  }
  for (const step of plan.steps) {
    await applyTransition(batch._id, step, {
      actor, source: "api",
      set:
        step === "processed"
          ? { processedAt: snap.processedAt ?? new Date(), processedVia: "webhook", payStatementRef: snap.payStatementRef ?? undefined, reconciliation: { status: "pending" } }
          : step === "failed"
            ? { failureReason: "Reported by provider sync" }
            : step === "voided"
              ? { voidedReason: "Reported by provider sync", voidedAt: new Date() }
              : { submittedToProviderAt: new Date() },
      summary: `Provider sync (${getGustoAdapter().name}) moved batch to ${step}`,
    });
  }
  summary.applied++;
}

export async function runGustoSync(actor: SessionUser, raw: z.input<typeof syncSchema>): Promise<SyncSummary> {
  assertCan(actor, "payroll.prepare");
  const input = syncSchema.parse(raw);
  await connectDb();
  const adapter = getGustoAdapter();
  const { route } = await gustoRoute();
  const summary: SyncSummary = { adapter: adapter.name, route, liveSync: adapter.verifiedProvider, checked: 0, applied: 0, messages: [] };

  try {
    const snaps: GustoPayrollSnapshot[] = [];
    if (input.batchId) {
      const b = await loadBatch(input.batchId);
      if (!b.externalRef) summary.messages.push("This batch has no Gusto payroll ID yet; nothing to sync.");
      else {
        const s = await adapter.fetchPayrollStatus(b.externalRef);
        if (s) snaps.push(s);
      }
    } else if (input.period) {
      snaps.push(...(await adapter.listPayrolls(input.period)));
    }
    summary.checked = snaps.length;
    for (const s of snaps) {
      const b = await PayrollBatch.findOne({ provider: "gusto", externalRef: s.externalRef }).lean<IPayrollBatch>();
      if (!b) {
        summary.messages.push(`Gusto payroll ${s.externalRef} has no CRM batch (not created automatically).`);
        continue;
      }
      if (adapter.verifiedProvider) await applySnapshot(actor, b, s, summary);
    }
    if (!adapter.verifiedProvider) {
      summary.messages.push("Manual workflow: no provider connection is configured. Enter provider evidence on the batch, or import the Gusto payroll register CSV.");
    }
    await logSync({
      kind: "sync", batchId: input.batchId ?? null, actorId: actor.id, source: "api",
      counts: { checked: summary.checked, applied: summary.applied },
      message: adapter.verifiedProvider ? `Sync via ${adapter.name}: ${summary.checked} checked, ${summary.applied} applied` : `Sync requested on the manual route (no network call): ${summary.messages.join(" ")}`,
    });
    await audit({ actor, source: "api", action: "system", entityType: "payroll_sync", entityId: input.batchId ?? null, summary: `Gusto sync run (${adapter.name}): ${summary.checked} checked, ${summary.applied} applied` });
    return summary;
  } catch (err) {
    await logSync({ kind: "sync", level: "error", batchId: input.batchId ?? null, actorId: actor.id, source: "api", message: `Sync failed: ${err instanceof Error ? err.message : "unknown error"}` });
    throw err;
  }
}
