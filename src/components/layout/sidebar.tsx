"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV } from "./nav-config";

/** `allowed` is the list of nav hrefs this user may see (computed on the server from RBAC). */
export function Sidebar({ allowed }: { allowed: string[] }) {
  const pathname = usePathname();
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => allowed.includes(i.href)) })).filter(
    (g) => g.items.length > 0,
  );
  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold text-white">CUS STEM CRM</span>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Main">
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.label && (
              <p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted">{g.label}</p>
            )}
            <ul className="space-y-0.5">
              {g.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                        active ? "bg-sidebar-active-bg text-white" : "hover:bg-sidebar-border hover:text-white",
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
