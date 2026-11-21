import { makeSchema, model } from "../base";

export interface ISavedView {
  _id: string;
  userId: string;
  module: string; // e.g. "candidates"
  name: string;
  query: string; // URL search string without leading "?"
  createdAt: Date;
}

const schema = makeSchema<ISavedView>({
  userId: { type: String, required: true, index: true },
  module: { type: String, required: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  query: { type: String, default: "" },
});
schema.index({ userId: 1, module: 1, name: 1 }, { unique: true });

export const SavedView = model<ISavedView>("SavedView", schema, "saved_views");
