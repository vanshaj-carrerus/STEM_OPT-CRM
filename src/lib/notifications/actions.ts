"use server";

import { requireAction } from "@/lib/auth/guard";
import { markAllNotificationsRead, markNotificationRead } from "./service";

/** Both actions are scoped to the signed-in user's own notifications (the service filters by userId). */
export async function markNotificationReadAction(id: string): Promise<void> {
  const user = await requireAction();
  if (typeof id !== "string" || !id) return;
  await markNotificationRead(user.id, id);
}

export async function markAllNotificationsReadAction(): Promise<void> {
  const user = await requireAction();
  await markAllNotificationsRead(user.id);
}
