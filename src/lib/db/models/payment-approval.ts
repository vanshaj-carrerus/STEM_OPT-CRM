import { makeSchema, makeAppendOnly, model } from "../base";

/**
 * One decision per approver per approval ROUND. A rejection sends the payment back to Draft; resubmitting starts a
 * new round (earlier approvals never carry over because the money fields may have changed).
 */
export interface IPaymentApproval {
  _id: string;
  paymentId: string;
  round: number;
  requestedBy: string;
  approverId: string;
  decision: "approve" | "reject";
  reason?: string;
  createdAt: Date;
}

const schema = makeSchema<IPaymentApproval>(
  {
    paymentId: { type: String, required: true, index: true },
    round: { type: Number, required: true },
    requestedBy: { type: String, required: true },
    approverId: { type: String, required: true, index: true },
    decision: { type: String, enum: ["approve", "reject"], required: true },
    reason: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// the same approver can only decide once per payment per round (spec: unique per payment+approver)
schema.index({ paymentId: 1, round: 1, approverId: 1 }, { unique: true });
makeAppendOnly(schema);

export const PaymentApproval = model<IPaymentApproval>("PaymentApproval", schema, "payment_approvals");
