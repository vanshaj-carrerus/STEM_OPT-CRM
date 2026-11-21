import {
  LayoutDashboard,
  Users,
  Building2,
  CalendarDays,
  FolderLock,
  Wallet,
  Siren,
  Landmark,
  BarChart3,
  Settings2,
  ScrollText,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/rbac/permissions";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Item is shown only if the user holds at least one of these permissions. */
  anyOf: Permission[];
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/** Add an entry here whenever a module ships. Nav visibility mirrors the same RBAC the API enforces. */
export const NAV: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, anyOf: ["dashboard.view"] },
      { href: "/candidates", label: "Candidates", icon: Users, anyOf: ["candidates.view"] },
      { href: "/employers", label: "Employers", icon: Building2, anyOf: ["immigration.view"] },
      { href: "/calendar", label: "Compliance calendar", icon: CalendarDays, anyOf: ["tasks.view"] },
      { href: "/documents", label: "Documents", icon: FolderLock, anyOf: ["documents.view"] },
    ],
  },
  {
    label: "Payroll & payments",
    items: [
      { href: "/payroll", label: "Payroll (Gusto)", icon: Wallet, anyOf: ["payroll.view"] },
      { href: "/emergency-payroll", label: "Emergency payroll", icon: Siren, anyOf: ["emergency.view"] },
      { href: "/payments", label: "Ria & wire payments", icon: Landmark, anyOf: ["payments.view"] },
    ],
  },
  {
    label: "Insights",
    items: [{ href: "/reports", label: "Reports", icon: BarChart3, anyOf: ["reports.view"] }],
  },
  {
    label: "Administration",
    items: [
      { href: "/admin/users", label: "Users & roles", icon: UserCog, anyOf: ["admin.users"] },
      { href: "/admin/settings", label: "Settings", icon: Settings2, anyOf: ["admin.settings"] },
      { href: "/admin/audit", label: "Audit log", icon: ScrollText, anyOf: ["audit.view"] },
    ],
  },
];
