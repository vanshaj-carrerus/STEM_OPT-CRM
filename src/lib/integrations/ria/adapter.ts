import { riaAutomationAllowed } from "@/lib/payments/rules";
import { convertMinor, MoneyError } from "@/lib/payments/money";

/**
 * Ria integration boundary. Ria's API is NEVER assumed to be usable for wage disbursement: automation stays off until
 * `riaAutomationAllowed(settings)` (business-use approval in writing + API configured). Until then the
 * `ManualRiaAdapter` is used: staff initiate the transfer in Ria's approved channel and record the reference in the CRM.
 */
export interface RiaQuoteRequest {
  sendAmountMinor: number;
  sendCurrency: string;
  receiveCurrency: string;
  /** manual mode only: the rate staff read from Ria's own quote screen */
  manualRate?: string;
}

export interface RiaQuote {
  sendAmountMinor: number;
  sendCurrency: string;
  receiveCurrency: string;
  fxRate: string;
  receiveAmountMinor: number;
  quotedAt: Date;
  source: "manual" | "api";
}

export interface RiaTransferRequest {
  /** MUST be the payment's UUID so a retry can never create a duplicate transfer. */
  idempotencyKey: string;
  sendAmountMinor: number;
  sendCurrency: string;
  receiveCurrency?: string;
  beneficiaryName: string;
  /** masked reference only; the provider holds the real destination details */
  destinationRef?: string;
}

export interface RiaTransferResult {
  transferId: string;
  status: string;
  idempotencyKey: string;
}

export interface RiaStatus {
  transferId: string;
  status: string;
  updatedAt: Date;
}

export interface RiaAdapter {
  readonly mode: "manual" | "api";
  getQuote(req: RiaQuoteRequest): Promise<RiaQuote>;
  submitTransfer(req: RiaTransferRequest): Promise<RiaTransferResult>;
  getStatus(transferId: string): Promise<RiaStatus>;
}

export class RiaAutomationDisabledError extends Error {
  status = 409;
  constructor(message = "Ria automated transfers are disabled until Ria's business-use approval and API access are confirmed; using manual reference tracking.") {
    super(message);
    this.name = "RiaAutomationDisabledError";
  }
}

/** No network, no side effects. Quotes are computed from a rate a human typed in; submit/status need a human. */
export class ManualRiaAdapter implements RiaAdapter {
  readonly mode = "manual" as const;
  async getQuote(req: RiaQuoteRequest): Promise<RiaQuote> {
    if (!req.manualRate) throw new MoneyError("Manual mode: enter the rate shown in Ria's quote screen.");
    return {
      sendAmountMinor: req.sendAmountMinor,
      sendCurrency: req.sendCurrency,
      receiveCurrency: req.receiveCurrency,
      fxRate: req.manualRate,
      receiveAmountMinor: convertMinor(req.sendAmountMinor, req.sendCurrency, req.receiveCurrency, req.manualRate),
      quotedAt: new Date(),
      source: "manual",
    };
  }
  async submitTransfer(): Promise<RiaTransferResult> {
    throw new RiaAutomationDisabledError("Submit the transfer in Ria's approved channel, then record the Ria transfer ID on the payment.");
  }
  async getStatus(): Promise<RiaStatus> {
    throw new RiaAutomationDisabledError("Status is tracked manually: update the payment from Ria's confirmation and attach the receipt.");
  }
}

let automated: RiaAdapter | null = null;
/** Production wiring point for a future approved API adapter. Ignored unless automation is allowed. */
export function registerAutomatedRiaAdapter(a: RiaAdapter | null) {
  automated = a;
}

export function getRiaAdapter(settings: { riaContractApproved?: boolean; riaApiConfigured?: boolean }): RiaAdapter {
  return riaAutomationAllowed(settings) && automated ? automated : new ManualRiaAdapter();
}
