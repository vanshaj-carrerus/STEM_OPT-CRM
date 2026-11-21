import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { ChangePasswordForm } from "./change-form";

export const metadata: Metadata = { title: "Change password" };

export default async function ChangePasswordPage() {
  const u = await getSessionUser();
  if (!u) redirect("/login");
  return <ChangePasswordForm forced={u.mustChangePassword} />;
}
