import { makeSchema, model } from "../base";

/** In-app notification shown in the topbar bell. Only ever read/updated by its own user. */
export interface INotification {
  _id: string;
  userId: string;
  title: string;
  body: string;
  link?: string;
  kind: "reminder" | "escalation" | "assignment" | "system";
  readAt?: Date | null;
  createdAt: Date;
}

const schema = makeSchema<INotification>(
  {
    userId: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    link: String,
    kind: { type: String, enum: ["reminder", "escalation", "assignment", "system"], default: "system" },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ userId: 1, readAt: 1, createdAt: -1 });
// keep the collection small: notifications expire after 180 days
schema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 86400 });

export const Notification = model<INotification>("Notification", schema, "notifications");
