/**
 * Linked adjustment events (long spec §8): partial payments, returns and corrections never edit the original
 * ledger row; they append signed deltas whose sum (plus the original amount) is the net amount.
 *   partial    — part of the instructed amount was NOT delivered   (delta < 0)
 *   return     — money came back from the beneficiary/bank         (delta < 0)
 *   correction — signed fix-up agreed in review                    (delta ≠ 0)
 * Cancellation / reversal / failure change STATUS (and are excluded from settled totals by status).
 */
export const MONEY_EVENT_KINDS = ["partial", "return", "correction"] as const;
export type MoneyEventKind = (typeof MONEY_EVENT_KINDS)[number];

export interface DeltaEvent {
  kind: string;
  amountDeltaMinor?: number | null;
}

export function isMoneyEvent(kind: string): kind is MoneyEventKind {
  return (MONEY_EVENT_KINDS as readonly string[]).includes(kind);
}

export function adjustmentTotal(events: readonly DeltaEvent[]): number {
  return events.reduce((sum, e) => (isMoneyEvent(e.kind) ? sum + (e.amountDeltaMinor ?? 0) : sum), 0);
}

export const netAmountMinor = (amountMinor: number, events: readonly DeltaEvent[]) => amountMinor + adjustmentTotal(events);

export type LinkedCheck = { ok: true; deltaMinor: number } | { ok: false; error: string };

/** Validates a requested linked event against the current net amount and returns the signed delta to append. */
export function validateLinkedEvent(kind: MoneyEventKind, netMinor: number, inputMinor: number): LinkedCheck {
  if (!Number.isSafeInteger(inputMinor) || inputMinor === 0) return { ok: false, error: "Enter a non-zero amount." };
  switch (kind) {
    case "partial":
    case "return": {
      if (inputMinor < 0) return { ok: false, error: "Enter the amount as a positive number." };
      if (inputMinor >= netMinor) {
        return {
          ok: false,
          error: kind === "partial" ? "A partial shortfall must be less than the net amount; use Fail/Reverse if nothing was delivered." : "A full return must be recorded with Reverse, not as a partial return.",
        };
      }
      return { ok: true, deltaMinor: -inputMinor };
    }
    case "correction": {
      if (netMinor + inputMinor <= 0) return { ok: false, error: "The correction would bring the net amount to zero or below; use Reverse instead." };
      return { ok: true, deltaMinor: inputMinor };
    }
  }
}
