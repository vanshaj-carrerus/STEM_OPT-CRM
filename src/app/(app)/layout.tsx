import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";
import { ROLE_LABELS } from "@/lib/rbac/permissions";
import { NAV } from "@/components/layout/nav-config";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { NotificationsSlot } from "@/components/layout/notifications-slot";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");

  const allowed = NAV.flatMap((g) => g.items)
    .filter((i) => i.anyOf.some((p) => can(user, p)))
    .map((i) => i.href);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar allowed={allowed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar name={user.name} roleLabel={ROLE_LABELS[user.role]} notifications={<NotificationsSlot userId={user.id} />} />
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
