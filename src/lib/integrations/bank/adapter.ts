/**
 * Bank boundary. Default is MANUAL: wires are sent in the bank's approved online channel by an authorized person,
 * who records the bank reference and attaches the bank confirmation in the CRM. The CRM never stores bank
 * credentials. A future statement/API feed would implement this interface.
 */
export interface BankTransactionStatus {
  reference: string;
  status: string;
  updatedAt: Date;
}

export interface BankAdapter {
  readonly mode: "manual" | "api";
  getTransactionStatus(reference: string): Promise<BankTransactionStatus>;
}

export class BankAutomationDisabledError extends Error {
  status = 409;
  constructor(message = "Bank API access is not configured; reconcile manually against the bank statement.") {
    super(message);
    this.name = "BankAutomationDisabledError";
  }
}

export class ManualBankAdapter implements BankAdapter {
  readonly mode = "manual" as const;
  async getTransactionStatus(): Promise<BankTransactionStatus> {
    throw new BankAutomationDisabledError();
  }
}

let automated: BankAdapter | null = null;
export function registerAutomatedBankAdapter(a: BankAdapter | null) {
  automated = a;
}

export function getBankAdapter(settings: { route?: "manual" | "api" }): BankAdapter {
  return settings.route === "api" && automated ? automated : new ManualBankAdapter();
}
