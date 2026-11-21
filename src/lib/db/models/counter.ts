import { makeSchema, model } from "../base";

interface ICounter {
  _id: string;
  seq: number;
}
const schema = makeSchema<ICounter>({ _id: { type: String }, seq: { type: Number, default: 0 } }, { timestamps: false });
export const Counter = model<ICounter>("Counter", schema, "counters");

/** Atomic, gap-tolerant sequence (used for human-friendly candidate codes like CND-000042). */
export async function nextSequence(name: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  return doc!.seq;
}
