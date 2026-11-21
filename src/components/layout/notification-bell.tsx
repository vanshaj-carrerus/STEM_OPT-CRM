"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as M from "@radix-ui/react-dropdown-menu";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { markAllNotificationsReadAction, markNotificationReadAction } from "@/lib/notifications/actions";
import { cn } from "@/lib/utils";

export interface BellItem {
  id: string;
  title: string;
  body: string;
  link?: string;
  kind: string;
  read: boolean;
  createdAt: string;
}

export function NotificationBell({ items, unread }: { items: BellItem[]; unread: number }) {
  const router = useRouter();
  const [list, setList] = useState(items);
  const [count, setCount] = useState(unread);
  const [, start] = useTransition();

  const openItem = (n: BellItem) => {
    if (!n.read) {
      setList((l) => l.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setCount((c) => Math.max(0, c - 1));
      start(() => markNotificationReadAction(n.id));
    }
    if (n.link) router.push(n.link);
  };

  return (
    <M.Root>
      <M.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${count ? ` (${count} unread)` : ""}`} className="relative">
          <Bell className="h-4 w-4" />
          {count > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </Button>
      </M.Trigger>
      <M.Portal>
        <M.Content align="end" sideOffset={8} className="z-50 w-80 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            <button
              type="button"
              disabled={count === 0}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
              onClick={() => {
                setList((l) => l.map((x) => ({ ...x, read: true })));
                setCount(0);
                start(() => markAllNotificationsReadAction());
              }}
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {list.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">You are all caught up.</p>
            ) : (
              list.map((n) => (
                <M.Item
                  key={n.id}
                  onSelect={() => openItem(n)}
                  className={cn("cursor-pointer border-b px-4 py-2.5 outline-none last:border-0 hover:bg-muted focus:bg-muted", !n.read && "bg-info-bg/40")}
                >
                  <p className={cn("text-sm", !n.read && "font-semibold")}>{n.title}</p>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>}
                  <p className="mt-1 text-[11px] text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</p>
                </M.Item>
              ))
            )}
          </div>
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
