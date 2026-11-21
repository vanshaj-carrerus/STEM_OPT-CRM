import { listMyNotifications } from "@/lib/notifications/service";
import { NotificationBell } from "./notification-bell";

/** Server component: loads the signed-in user's own notifications for the topbar bell. */
export async function NotificationsSlot({ userId }: { userId: string }) {
  try {
    const { items, unread } = await listMyNotifications(userId, 15);
    return <NotificationBell items={items} unread={unread} />;
  } catch {
    return null; // the bell is non-essential; never break page rendering over it
  }
}
