"use client";

import { useEffect, useState } from "react";
import { LogOut, Moon, Sun, KeyRound } from "lucide-react";
import Link from "next/link";
import { logoutAction } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const saved = (() => {
      try {
        return localStorage.getItem("crm-theme");
      } catch {
        return null;
      }
    })();
    const isDark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    setDark(isDark);
  }, []);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle dark mode"
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.dataset.theme = next ? "dark" : "light";
        try {
          localStorage.setItem("crm-theme", next ? "dark" : "light");
        } catch {}
      }}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

export function Topbar({ name, roleLabel, notifications }: { name: string; roleLabel: string; notifications?: React.ReactNode }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-card px-4 md:px-6">
      <div className="text-sm text-muted-foreground md:hidden font-semibold text-foreground">Compliance CRM</div>
      <div className="hidden md:block" />
      <div className="flex items-center gap-1.5">
        {notifications}
        <ThemeToggle />
        <div className="ml-2 flex items-center gap-2.5 border-l pl-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
            {initials}
          </span>
          <div className="hidden leading-tight sm:block">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted-foreground">{roleLabel}</p>
          </div>
          <Button asChild variant="ghost" size="icon" aria-label="Change password">
            <Link href="/change-password">
              <KeyRound className="h-4 w-4" />
            </Link>
          </Button>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost" size="icon" aria-label="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
