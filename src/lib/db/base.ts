import { randomUUID } from "node:crypto";
import mongoose, { Schema, type SchemaDefinition, type SchemaOptions, type Model } from "mongoose";

export const newId = () => randomUUID();

/**
 * Every collection uses a string UUID `_id` (never email / SEVIS / SSN).
 * The generic is only used to document the document shape at call sites; model typing comes from `model<T>()`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function makeSchema<T = unknown>(def: SchemaDefinition, opts: SchemaOptions = {}): Schema {
  return new Schema({ _id: { type: String, default: newId }, ...def } as SchemaDefinition, {
    timestamps: true,
    versionKey: false,
    ...opts,
  } as SchemaOptions);
}

/** Register a model once (safe across Next.js hot reloads). */
export function model<T>(name: string, schema: Schema, collection?: string): Model<T> {
  return (mongoose.models[name] as Model<T>) || (mongoose.model(name, schema, collection) as unknown as Model<T>);
}

/** Block update/delete on a schema so the collection is append-only (audit log, payment events...). */
export function makeAppendOnly(schema: Schema) {
  const reject = function () {
    throw new Error("This collection is append-only; updates and deletes are not permitted.");
  };
  for (const op of [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "findOneAndReplace",
    "replaceOne",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete",
  ] as const) {
    schema.pre(op as never, reject);
  }
  schema.pre("save", function () {
    if (!this.isNew) reject();
  });
}
