import { z } from "zod";
import { isDateOnly } from "@/lib/compliance/dates";
import { PAYMENT_TYPES, type PaymentType } from "./rules";
import { MoneyError, assertCurrency, convertMinor, normalizeRate, parseAmountToMinor } from "./money";
import { cardNumberError, validateDestinationReference, validateProviderReference } from "./destination";
import { PaymentError } from "./errors";

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(s: T) => z.preprocess(emptyToUndef, s.optional());
const money = z.union([z.string(), z.number()]).transform((v) => String(v));

/** Input accepted by create/edit (REST body or form fields). All free text is length-bounded. */
export const paymentInputSchema = z.object({
  candidateId: z.string().min(1),
  type: z.enum(PAYMENT_TYPES),
  amount: money,
  currency: z.string().min(3).max(3),
  fee: opt(money),
  fxRate: opt(z.union([z.string(), z.number()]).transform((v) => String(v))),
  convertedCurrency: opt(z.string().length(3)),
  fxQuotedAt: opt(z.string().max(40)),
  reason: z.string().trim().min(3, "Enter the pay period / invoice / reason").max(300),
  payPeriodStart: opt(z.string().max(10)),
  payPeriodEnd: opt(z.string().max(10)),
  invoiceRef: opt(z.string().trim().max(60)),
  recipientName: opt(z.string().trim().max(120)),
  recipientDestination: opt(z.string().max(160)),
  providerReference: opt(z.string().trim().max(64)),
  linkedPaymentId: opt(z.string().max(60)),
  retryOf: opt(z.string().max(60)),
});
export type PaymentInput = z.infer<typeof paymentInputSchema>;

export interface BuiltPaymentFields {
  candidateId: string;
  type: PaymentType;
  amountMinor: number;
  currency: string;
  feeMinor: number;
  fxRate: string | null;
  fxQuotedAt: Date | null;
  convertedAmountMinor: number | null;
  convertedCurrency: string | null;
  reason: string;
  payPeriodStart: string | null;
  payPeriodEnd: string | null;
  invoiceRef: string | null;
  recipientName: string | null;
  recipientDestination: string | null;
  destinationWasMasked: boolean;
  providerReference: string | null;
  linkedPaymentId: string | null;
  retryOf: string | null;
}

/**
 * Validate + normalise input into ledger fields (integer minor units, masked destination, server-computed FX
 * conversion). Throws PaymentError(422) with per-field messages. Pure; safe to unit-test.
 */
export function buildPaymentFields(input: PaymentInput, now: Date = new Date()): BuiltPaymentFields {
  const errors: Record<string, string> = {};
  const fail = (k: string, m: string) => {
    errors[k] ||= m;
  };

  let currency = "USD";
  try {
    currency = assertCurrency(input.currency);
  } catch (e) {
    fail("currency", (e as MoneyError).message);
  }

  let amountMinor = 0;
  try {
    amountMinor = parseAmountToMinor(input.amount, currency);
    if (amountMinor <= 0) fail("amount", "Amount must be greater than zero");
  } catch (e) {
    fail("amount", (e as MoneyError).message);
  }

  let feeMinor = 0;
  if (input.fee !== undefined) {
    try {
      feeMinor = parseAmountToMinor(input.fee, currency);
    } catch (e) {
      fail("fee", (e as MoneyError).message);
    }
  }

  let fxRate: string | null = null;
  let fxQuotedAt: Date | null = null;
  let convertedAmountMinor: number | null = null;
  let convertedCurrency: string | null = null;
  if (input.fxRate !== undefined || input.convertedCurrency !== undefined) {
    try {
      if (input.fxRate === undefined) throw new MoneyError("Enter the FX rate that was quoted");
      fxRate = normalizeRate(input.fxRate);
    } catch (e) {
      fail("fxRate", (e as MoneyError).message);
    }
    try {
      if (input.convertedCurrency === undefined) throw new MoneyError("Enter the destination (converted) currency");
      convertedCurrency = assertCurrency(input.convertedCurrency);
      if (convertedCurrency === currency) fail("convertedCurrency", "Converted currency must differ from the sent currency");
    } catch (e) {
      fail("convertedCurrency", (e as MoneyError).message);
    }
    if (!input.fxQuotedAt) fail("fxQuotedAt", "Enter when the FX rate was quoted");
    else {
      const t = new Date(input.fxQuotedAt);
      if (Number.isNaN(t.getTime())) fail("fxQuotedAt", "Quote timestamp is not a valid date/time");
      else if (t.getTime() > now.getTime() + 5 * 60_000) fail("fxQuotedAt", "Quote timestamp cannot be in the future");
      else fxQuotedAt = t;
    }
    if (fxRate && convertedCurrency && amountMinor > 0 && !errors.amount && !errors.fxRate && !errors.convertedCurrency) {
      try {
        convertedAmountMinor = convertMinor(amountMinor, currency, convertedCurrency, fxRate);
      } catch (e) {
        fail("fxRate", (e as MoneyError).message);
      }
    }
  }

  for (const [k, v] of [["payPeriodStart", input.payPeriodStart], ["payPeriodEnd", input.payPeriodEnd]] as const) {
    if (v !== undefined && !isDateOnly(v)) fail(k, "Use a valid date (YYYY-MM-DD)");
  }
  if (input.payPeriodStart && input.payPeriodEnd && isDateOnly(input.payPeriodStart) && isDateOnly(input.payPeriodEnd) && input.payPeriodEnd < input.payPeriodStart) {
    fail("payPeriodEnd", "Period end is before period start");
  }

  const dest = validateDestinationReference(input.recipientDestination);
  if (!dest.ok) fail("recipientDestination", dest.error ?? "Invalid destination reference");

  let providerReference: string | null = null;
  if (input.providerReference !== undefined) {
    const r = validateProviderReference(input.providerReference);
    if (!r.ok) fail("providerReference", r.error ?? "Invalid reference");
    else providerReference = r.value;
  }

  for (const [k, label, v] of [
    ["reason", "Reason", input.reason],
    ["recipientName", "Recipient name", input.recipientName],
    ["invoiceRef", "Invoice reference", input.invoiceRef],
  ] as const) {
    const msg = cardNumberError(v, label);
    if (msg) fail(k, msg);
  }

  if (Object.keys(errors).length) throw new PaymentError("Please fix the highlighted fields.", 422, "validation", errors);

  return {
    candidateId: input.candidateId,
    type: input.type,
    amountMinor,
    currency,
    feeMinor,
    fxRate,
    fxQuotedAt,
    convertedAmountMinor,
    convertedCurrency,
    reason: input.reason,
    payPeriodStart: input.payPeriodStart ?? null,
    payPeriodEnd: input.payPeriodEnd ?? null,
    invoiceRef: input.invoiceRef ?? null,
    recipientName: input.recipientName ?? null,
    recipientDestination: dest.masked || null,
    destinationWasMasked: dest.wasMasked,
    providerReference,
    linkedPaymentId: input.linkedPaymentId ?? null,
    retryOf: input.retryOf ?? null,
  };
}

/** What must be true before a draft may be sent for approval ("validate candidate + payee + amount"). */
export function readinessIssues(p: {
  type: PaymentType;
  amountMinor: number;
  reason?: string | null;
  recipientName?: string | null;
  recipientDestination?: string | null;
}): string[] {
  const issues: string[] = [];
  if (!(p.amountMinor > 0)) issues.push("Amount must be greater than zero.");
  if (!p.reason?.trim()) issues.push("Enter the pay period, invoice or reason.");
  if (p.type !== "payroll_settlement") {
    if (!p.recipientName?.trim()) issues.push("Recipient name is required.");
  }
  if (p.type === "ria_transfer" || p.type === "domestic_wire" || p.type === "international_wire") {
    if (!p.recipientDestination?.trim()) issues.push("A masked destination reference (e.g. last 4 digits) is required.");
  }
  return issues;
}

export const reasonSchema = z.string().trim().min(5, "Enter a reason (at least 5 characters)").max(500);
export const noteSchema = z.string().trim().max(500).optional();

export const submissionSchema = z.object({
  providerReference: z.string().trim().min(1, "A Ria transfer ID / bank reference is required").max(64),
  note: noteSchema,
});

export const reconcileSchema = z.object({
  statementRef: z.string().trim().min(3, "Enter the bank statement / provider report reference").max(80),
  settledAmount: money,
  statementDate: opt(z.string().max(10)),
  note: noteSchema,
  mismatchResolution: noteSchema,
});

export const linkedEventSchema = z.object({
  kind: z.enum(["partial", "return", "correction"]),
  amount: money,
  reason: reasonSchema,
  providerReference: opt(z.string().trim().max(64)),
});
