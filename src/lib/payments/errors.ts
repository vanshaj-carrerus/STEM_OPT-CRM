/** Domain errors for the payments module. Mapped to HTTP statuses by `paymentRoute` / server-action helpers. */
export class PaymentError extends Error {
  constructor(
    message: string,
    public status: number = 422,
    public code: string = "payment_error",
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export class PaymentNotFoundError extends PaymentError {
  constructor() {
    super("Payment not found", 404, "not_found");
    this.name = "PaymentNotFoundError";
  }
}

export class PaymentConflictError extends PaymentError {
  constructor(message = "This payment was changed by someone else. Reload and try again.") {
    super(message, 409, "conflict");
    this.name = "PaymentConflictError";
  }
}
