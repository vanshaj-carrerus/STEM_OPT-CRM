import { connectDb } from "@/lib/db/connect";
import { User, type IUser } from "@/lib/db/models/user";
import type { Role } from "@/lib/rbac/permissions";

export interface UserOption {
  id: string;
  name: string;
  role: Role;
}

/** Roles that may be assigned as a candidate's compliance owner. */
export const ASSIGNABLE_ROLES: Role[] = ["super_admin", "compliance_manager", "compliance_associate"];

/** Active staff who can own compliance work (assignee pickers). Never exposes emails/hashes. */
export async function listAssignableUsers(): Promise<UserOption[]> {
  await connectDb();
  const rows = await User.find({ active: true, role: { $in: ASSIGNABLE_ROLES } })
    .select("name role")
    .sort({ name: 1 })
    .lean<IUser[]>();
  return rows.map((u) => ({ id: u._id, name: u.name, role: u.role }));
}

export async function userNameMap(ids: (string | null | undefined)[]): Promise<Record<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean) as string[])];
  if (!uniq.length) return {};
  await connectDb();
  const rows = await User.find({ _id: { $in: uniq } }).select("name").lean<IUser[]>();
  return Object.fromEntries(rows.map((u) => [u._id, u.name]));
}
