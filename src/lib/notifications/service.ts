import { connectDb } from "@/lib/db/connect";
import { Notification, type INotification } from "@/lib/db/models/notification";

export interface NewNotification {
  title: string;
  body?: string;
  link?: string;
  kind?: INotification["kind"];
}

/** Create the same in-app notification for several users. */
export async function createNotifications(userIds: string[], n: NewNotification) {
  if (!userIds.length) return 0;
  await connectDb();
  const docs = [...new Set(userIds)].map((userId) => ({
    userId,
    title: n.title,
    body: n.body ?? "",
    link: n.link,
    kind: n.kind ?? "system",
  }));
  await Notification.insertMany(docs);
  return docs.length;
}

export interface NotificationView {
  id: string;
  title: string;
  body: string;
  link?: string;
  kind: INotification["kind"];
  read: boolean;
  createdAt: string;
}

/** A user only ever sees their own notifications. */
export async function listMyNotifications(userId: string, limit = 20): Promise<{ items: NotificationView[]; unread: number }> {
  await connectDb();
  const [rows, unread] = await Promise.all([
    Notification.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean<INotification[]>(),
    Notification.countDocuments({ userId, readAt: null }),
  ]);
  return {
    unread,
    items: rows.map((r) => ({
      id: r._id,
      title: r.title,
      body: r.body,
      link: r.link,
      kind: r.kind,
      read: !!r.readAt,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** Scoped by userId so one user can never mark another user's notifications. */
export async function markNotificationRead(userId: string, id: string) {
  await connectDb();
  await Notification.updateOne({ _id: id, userId, readAt: null }, { $set: { readAt: new Date() } });
}

export async function markAllNotificationsRead(userId: string) {
  await connectDb();
  await Notification.updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
}
