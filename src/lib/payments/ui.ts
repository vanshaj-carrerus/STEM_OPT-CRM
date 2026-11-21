import type { PaymentStatus } from "./rules";

/** DB-free UI helpers (safe to import from client components). */
export type StatusTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

export const STATUS_TONE: Record<PaymentStatus, StatusTone> = {
  draft: "neutral",
  awaiting_approval: "warning",
  approved: "info",
  submitted: "info",
  processing: "info",
  paid: "warning", // paid but not yet reconciled stays visible
  failed: "danger",
  cancelled: "neutral",
  reversed: "danger",
  reconciled: "success",
};

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** A command the detail page offers to the viewer (already filtered by permission, status and separation of duties). */
export interface CommandField {
  name: string;
  label: string;
  kind: "text" | "textarea" | "amount" | "date" | "select";
  required?: boolean;
  hint?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
}

export interface CommandSpec {
  command: string;
  label: string;
  description?: string;
  variant?: "primary" | "secondary" | "outline" | "danger";
  fields: CommandField[];
  confirmLabel?: string;
}
