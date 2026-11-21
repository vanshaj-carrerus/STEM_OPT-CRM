import { isHighRisk, requiredApprovals, DEFAULT_HIGH_RISK_THRESHOLD_USD, type PaymentType } from "./rules";

/** USD value (minor units) used for the high-risk threshold; null when it cannot be determined. */
export function usdMinorOf(p: {
  currency: string;
  amountMinor: number;
  convertedCurrency?: string | null;
  convertedAmountMinor?: number | null;
}): number | null {
  if (p.currency === "USD") return p.amountMinor;
  if (p.convertedCurrency === "USD" && typeof p.convertedAmountMinor === "number") return p.convertedAmountMinor;
  return null;
}

export interface RiskContext {
  type: PaymentType;
  currency: string;
  amountMinor: number;
  convertedCurrency?: string | null;
  convertedAmountMinor?: number | null;
  newRecipient?: boolean;
  recipientChanged?: boolean;
  thresholdUsd?: number;
}

export interface RiskAssessment {
  highRisk: boolean;
  requiredApprovals: number;
  reasons: string[];
  amountUsdMinor: number | null;
}

/**
 * Wraps the shared `isHighRisk` engine and explains WHY. An amount whose USD value is unknown is treated as
 * high-risk (fail safe) rather than slipping under the threshold.
 */
export function assessRisk(c: RiskContext): RiskAssessment {
  const thresholdUsd = c.thresholdUsd ?? DEFAULT_HIGH_RISK_THRESHOLD_USD;
  const usdMinor = usdMinorOf(c);
  // payroll settlements are tracked with their Gusto reference; recipient novelty doesn't apply
  const recipientRelevant = c.type !== "payroll_settlement";
  const newRecipient = recipientRelevant && !!c.newRecipient;
  const recipientChanged = recipientRelevant && !!c.recipientChanged;
  const amountUsd = usdMinor === null ? Number.MAX_SAFE_INTEGER : usdMinor / 100;
  const highRisk = isHighRisk({ type: c.type, amountUsd, recipientChanged, newRecipient, thresholdUsd });

  const reasons: string[] = [];
  if (usdMinor === null) reasons.push("USD value could not be determined — treated as high-risk");
  else if (usdMinor / 100 >= thresholdUsd) reasons.push(`Amount is at or above the high-risk threshold (${thresholdUsd.toLocaleString("en-US")} USD)`);
  if (c.type === "international_wire") reasons.push("International wire");
  if (newRecipient) reasons.push("New recipient for this candidate");
  if (recipientChanged) reasons.push("Recipient changed compared with previous payments");
  return { highRisk, requiredApprovals: requiredApprovals(highRisk), reasons, amountUsdMinor: usdMinor };
}

/**
 * New / changed recipient detection against payments that actually moved money.
 * `priorFingerprints` is chronological (oldest → newest) for the same candidate.
 */
export function classifyRecipient(current: string | null, priorFingerprints: readonly (string | null | undefined)[]) {
  const prior = priorFingerprints.filter((f): f is string => !!f);
  if (!current) return { newRecipient: false, recipientChanged: false };
  if (prior.length === 0) return { newRecipient: true, recipientChanged: false };
  return { newRecipient: false, recipientChanged: prior[prior.length - 1] !== current };
}
