import { makeSchema, model } from "../base";

export const REMINDER_STATUSES = ["pending", "sent", "failed", "skipped"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

/** Bounded retry: a failed reminder is retried by later worker runs until this many attempts were made. */
export const MAX_REMINDER_ATTEMPTS = 4;

/**
 * One row per logical reminder. `key` (reminderKey = candidate+taskType+dueDate+channel+offset+audience) is UNIQUE:
 * the worker INSERTS first and only sends if the insert won, so parallel workers / retries can never duplicate (AC-08).
 */
export interface IReminder {
  _id: string;
  key: string;
  candidateId: string | null;
  taskId: string;
  taskType: string;
  dueDate: string;
  channel: "in_app" | "email";
  audience: "staff" | "candidate";
  /** "30" | "14" | ... | "0" | "overdue-L1" ... */
  offset: string;
  status: ReminderStatus;
  attempts: number;
  lastError?: string;
  sentAt?: Date | null;
  templateKey: string;
  /** Who receives it: staff user ids (in_app/email) or, for candidates, `toEmail`. */
  recipientIds: string[];
  toEmail?: string | null;
  /** Rendered content snapshot so retries resend exactly the same message. */
  payload: { subject: string; title: string; body: string; link: string; kind?: string };
  createdAt: Date;
  updatedAt: Date;
}

const schema = makeSchema<IReminder>({
  key: { type: String, required: true },
  candidateId: { type: String, default: null },
  taskId: { type: String, required: true, index: true },
  taskType: { type: String, required: true },
  dueDate: { type: String, required: true },
  channel: { type: String, enum: ["in_app", "email"], required: true },
  audience: { type: String, enum: ["staff", "candidate"], required: true },
  offset: { type: String, required: true },
  status: { type: String, enum: REMINDER_STATUSES, default: "pending", index: true },
  attempts: { type: Number, default: 0 },
  lastError: String,
  sentAt: { type: Date, default: null },
  templateKey: { type: String, required: true },
  recipientIds: { type: [String], default: [] },
  toEmail: { type: String, default: null },
  payload: { type: Object, default: {} },
});
schema.index({ key: 1 }, { unique: true });

export const Reminder = model<IReminder>("Reminder", schema, "reminders");

/** Delivery log, one row per recipient per attempt. Staff and candidate audiences are logged separately. */
export interface INotificationLog {
  _id: string;
  audience: "staff" | "candidate";
  channel: "in_app" | "email";
  /** user id (in_app / staff email) or candidate email address */
  to: string;
  templateKey: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
  reminderKey?: string;
  taskId?: string | null;
  candidateId?: string | null;
  sentAt: Date;
  createdAt: Date;
}

const logSchema = makeSchema<INotificationLog>(
  {
    audience: { type: String, enum: ["staff", "candidate"], required: true, index: true },
    channel: { type: String, enum: ["in_app", "email"], required: true },
    to: { type: String, required: true },
    templateKey: { type: String, required: true },
    status: { type: String, enum: ["sent", "failed", "skipped"], required: true, index: true },
    error: String,
    reminderKey: String,
    taskId: { type: String, default: null, index: true },
    candidateId: { type: String, default: null },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
logSchema.index({ sentAt: -1 });

export const NotificationLog = model<INotificationLog>("NotificationLog", logSchema, "notification_logs");
