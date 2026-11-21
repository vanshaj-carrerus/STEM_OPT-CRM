import { can, type Actor } from "@/lib/rbac/can";
import type { CommandSpec } from "./ui";
import type { PaymentView } from "./view";
import { evidenceRequirementText } from "./evidence";
import { formatMinorPlain } from "./money";

/**
 * Which workflow actions to OFFER this viewer right now. This only shapes the UI — every service function re-checks
 * permissions, status and separation of duties server-side, so a forged request is still refused.
 */
export function availableCommands(actor: Actor, p: PaymentView, ctx: { decidedByMe: boolean }): CommandSpec[] {
  const out: CommandSpec[] = [];
  const isRequester = p.createdBy === actor.id || p.requestedBy === actor.id;
  const reason = (label: string) => ({ name: "reason", label, kind: "textarea" as const, required: true, placeholder: "At least 5 characters" });

  if (p.status === "draft" && can(actor, "payments.prepare")) {
    out.push({ command: "submit_for_approval", label: "Send for approval", variant: "primary", description: "Locks the money fields. Approvers are assigned automatically; high-risk payments need two distinct approvers.", fields: [] });
  }

  if (p.status === "awaiting_approval" && can(actor, "payments.approve") && !isRequester && !ctx.decidedByMe && !p.approvedBy.includes(actor.id)) {
    out.push({ command: "approve", label: "Approve", variant: "primary", description: `Approval ${p.approvedBy.length + 1} of ${p.requiredApprovals}. You cannot approve a payment you created or requested.`, fields: [{ name: "note", label: "Note (optional)", kind: "text" }] });
    out.push({ command: "reject", label: "Reject", variant: "danger", description: "Sends the payment back to Draft. A reason is required.", fields: [reason("Reason for rejection")] });
  }

  if (p.status === "approved" && can(actor, "payments.submit")) {
    out.push({
      command: "record_submission", label: "Record submission", variant: "primary",
      description: "Initiate the transfer OUTSIDE the CRM (Ria or the bank's approved channel), then record the reference here. The CRM never moves money.",
      fields: [
        { name: "providerReference", label: p.type === "ria_transfer" ? "Ria transfer ID" : p.type === "payroll_settlement" ? "Gusto payroll ID" : "Bank reference number", kind: "text", required: true, hint: "4–64 characters. Never a card or account number." },
        { name: "note", label: "Note (optional)", kind: "text" },
      ],
    });
  }
  if (p.status === "submitted" && can(actor, "payments.submit")) {
    out.push({ command: "processing", label: "Mark processing", variant: "outline", fields: [{ name: "note", label: "Note (optional)", kind: "text" }] });
  }
  if ((p.status === "submitted" || p.status === "processing") && can(actor, "payments.submit")) {
    out.push({
      command: "paid", label: "Mark paid", variant: "primary",
      description: `Requires the provider reference and evidence on file. ${evidenceRequirementText(p.type)}`,
      fields: [{ name: "paidAt", label: "Paid date (optional)", kind: "date" }, { name: "note", label: "Note (optional)", kind: "text" }],
    });
    out.push({ command: "failed", label: "Mark failed", variant: "danger", description: "Failed payments stay visible and raise a follow-up task. A retry is a NEW linked payment.", fields: [reason("Failure reason")] });
  }

  const cancellable =
    p.status === "draft" || p.status === "awaiting_approval"
      ? can(actor, "payments.prepare") || can(actor, "payments.approve") || can(actor, "payments.submit")
      : ["approved", "submitted", "failed"].includes(p.status) && (can(actor, "payments.submit") || can(actor, "payments.reconcile"));
  if (cancellable) out.push({ command: "cancel", label: "Cancel", variant: "danger", description: "Cancelled payments are kept in the ledger; nothing is deleted.", fields: [reason("Reason for cancellation")] });

  if ((p.status === "paid" || p.status === "reconciled") && (can(actor, "payments.submit") || can(actor, "payments.reconcile"))) {
    const kinds = [
      { value: "partial", label: "Partial payment — amount NOT delivered" },
      { value: "return", label: "Partial return — money came back" },
      ...(can(actor, "payments.reconcile") ? [{ value: "correction", label: "Correction (signed, e.g. -25.00)" }] : []),
    ];
    out.push({
      command: "linked", label: "Record partial / return / correction", variant: "outline",
      description: "Recorded as a linked event; the original ledger row is never edited.",
      fields: [
        { name: "kind", label: "Event", kind: "select", required: true, options: kinds },
        { name: "amount", label: "Amount", kind: "amount", required: true, hint: "Positive for partial/return; signed for correction." },
        reason("Reason"),
      ],
    });
  }
  if ((p.status === "paid" || p.status === "reconciled") && (p.status === "reconciled" ? can(actor, "payments.reconcile") : can(actor, "payments.submit") || can(actor, "payments.reconcile"))) {
    out.push({ command: "reverse", label: "Reverse / returned", variant: "danger", description: "Full return of the transfer. The row stays flagged for review.", fields: [reason("Reason / return reference")] });
  }
  if (p.status !== "cancelled" && p.status !== "draft" && (can(actor, "payments.submit") || can(actor, "payments.approve") || can(actor, "payments.reconcile")) && !p.beneficiaryMismatch) {
    out.push({ command: "mismatch", label: "Flag beneficiary mismatch", variant: "outline", fields: [reason("What does not match?")] });
  }

  const reconcilerBlocked = p.highRisk && (isRequester || p.approvedBy.includes(actor.id));
  if (p.status === "paid" && can(actor, "payments.reconcile") && !reconcilerBlocked) {
    out.push({
      command: "reconcile", label: "Reconcile", variant: "primary",
      description: "Match against the bank statement or provider report. The statement amount must equal the ledger net amount.",
      fields: [
        { name: "statementRef", label: "Statement / provider report reference", kind: "text", required: true },
        { name: "settledAmount", label: `Settled amount (${p.currency})`, kind: "amount", required: true, hint: `Ledger net: ${formatMinorPlain(p.netMinor, p.currency)} ${p.currency}` },
        { name: "statementDate", label: "Statement date", kind: "date" },
        ...(p.beneficiaryMismatch ? [{ name: "mismatchResolution", label: "How was the beneficiary mismatch resolved?", kind: "textarea" as const, required: true }] : []),
        { name: "note", label: "Note (optional)", kind: "text" as const },
      ],
    });
  }
  return out;
}
