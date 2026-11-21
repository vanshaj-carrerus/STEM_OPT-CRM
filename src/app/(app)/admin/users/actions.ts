"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { User } from "@/lib/db/models/user";
import { getSessionUser } from "@/lib/auth/session";
import { destroyAllSessionsFor } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { assertCan } from "@/lib/rbac/can";
import { PERMISSIONS, ROLES } from "@/lib/rbac/permissions";
import { audit } from "@/lib/audit";

export interface UserFormState {
  error?: string;
  ok?: boolean;
  tempPassword?: string;
  email?: string;
}

/** Random temp password that satisfies the password policy. Shown once to the admin. */
function tempPassword() {
  const core = randomBytes(9).toString("base64url");
  return `${core}aA1!`;
}

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ROLES),
  teamLeadId: z.string().optional(),
  timezone: z.string().default("America/New_York"),
});

export async function createUserAction(_p: UserFormState, fd: FormData): Promise<UserFormState> {
  const actor = await getSessionUser();
  assertCan(actor, "admin.users");
  const parsed = createSchema.safeParse({
    name: fd.get("name"),
    email: fd.get("email"),
    role: fd.get("role"),
    teamLeadId: fd.get("teamLeadId") || undefined,
    timezone: fd.get("timezone") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  await connectDb();
  if (await User.exists({ email: parsed.data.email })) return { error: "A user with that email already exists." };

  const temp = tempPassword();
  const user = await User.create({
    ...parsed.data,
    teamLeadId: parsed.data.teamLeadId || null,
    passwordHash: await hashPassword(temp),
    mustChangePassword: true,
    createdBy: actor.id,
  });
  await audit({
    actor,
    action: "create",
    entityType: "user",
    entityId: user._id,
    summary: `Created user ${user.email} (${user.role})`,
    after: { email: user.email, role: user.role, name: user.name },
  });
  revalidatePath("/admin/users");
  return { ok: true, tempPassword: temp, email: user.email };
}

const updateSchema = z.object({
  id: z.string(),
  role: z.enum(ROLES),
  active: z.coerce.boolean(),
  teamLeadId: z.string().optional(),
  extraPermissions: z.array(z.enum(PERMISSIONS)).default([]),
});

export async function updateUserAction(_p: UserFormState, fd: FormData): Promise<UserFormState> {
  const actor = await getSessionUser();
  assertCan(actor, "admin.users");
  const parsed = updateSchema.safeParse({
    id: fd.get("id"),
    role: fd.get("role"),
    active: fd.get("active") === "on",
    teamLeadId: fd.get("teamLeadId") || undefined,
    extraPermissions: fd.getAll("extraPermissions"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  await connectDb();
  const user = await User.findById(d.id);
  if (!user) return { error: "User not found." };

  if (user._id === actor.id && (!d.active || d.role !== user.role)) {
    return { error: "You cannot deactivate yourself or change your own role." };
  }
  // never leave the system without an active Super Admin
  if (user.role === "super_admin" && (d.role !== "super_admin" || !d.active)) {
    const others = await User.countDocuments({ role: "super_admin", active: true, _id: { $ne: user._id } });
    if (others === 0) return { error: "At least one active Super Admin is required." };
  }

  const before = { role: user.role, active: user.active, teamLeadId: user.teamLeadId, extraPermissions: user.extraPermissions };
  user.role = d.role;
  user.active = d.active;
  user.teamLeadId = d.teamLeadId || null;
  user.extraPermissions = d.extraPermissions;
  await user.save();
  if (!d.active) await destroyAllSessionsFor(user._id);

  const after = { role: user.role, active: user.active, teamLeadId: user.teamLeadId, extraPermissions: user.extraPermissions };
  await audit({
    actor,
    action: "permission_change",
    entityType: "user",
    entityId: user._id,
    summary: `Updated access for ${user.email}`,
    before,
    after,
  });
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function resetUserPasswordAction(_p: UserFormState, fd: FormData): Promise<UserFormState> {
  const actor = await getSessionUser();
  assertCan(actor, "admin.users");
  const id = String(fd.get("id") ?? "");
  await connectDb();
  const user = await User.findById(id);
  if (!user) return { error: "User not found." };
  const temp = tempPassword();
  await User.updateOne(
    { _id: id },
    { $set: { passwordHash: await hashPassword(temp), mustChangePassword: true, failedLogins: 0, lockedUntil: null } },
  );
  await destroyAllSessionsFor(id);
  await audit({ actor, action: "password_change", entityType: "user", entityId: id, summary: `Admin reset password for ${user.email}` });
  return { ok: true, tempPassword: temp, email: user.email };
}
