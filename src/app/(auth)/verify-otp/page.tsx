import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getPendingOtpSession } from "@/lib/auth/session";
import { User } from "@/lib/db/models/user";
import { OtpForm } from "./otp-form";

export const metadata: Metadata = { title: "Verify code" };

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.max(2, local.length - 2))}@${domain}`;
}

export default async function VerifyOtpPage() {
  const pending = await getPendingOtpSession();
  if (!pending) redirect("/login");
  const user = await User.findById(pending.userId).lean();
  if (!user) redirect("/login");
  return <OtpForm email={maskEmail(user.email)} />;
}
