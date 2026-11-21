import { makeSchema, model } from "../base";
import { ROLES, PERMISSIONS, type Role, type Permission } from "@/lib/rbac/permissions";

export interface IUser {
  _id: string;
  name: string;
  email: string; // lowercased, unique
  passwordHash: string;
  role: Role;
  active: boolean;
  emailVerified: boolean;
  mustChangePassword: boolean;
  extraPermissions: Permission[];
  deniedPermissions: Permission[];
  teamLeadId?: string | null; // escalation ladder: owner → team lead
  teamIds: string[];
  timezone: string;
  failedLogins: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date | null;
  passwordChangedAt?: Date | null;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = makeSchema<IUser>({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ROLES, required: true, index: true },
  active: { type: Boolean, default: true },
  emailVerified: { type: Boolean, default: false },
  mustChangePassword: { type: Boolean, default: false },
  extraPermissions: { type: [String], enum: PERMISSIONS, default: [] },
  deniedPermissions: { type: [String], enum: PERMISSIONS, default: [] },
  teamLeadId: { type: String, default: null },
  teamIds: { type: [String], default: [] },
  timezone: { type: String, default: "America/New_York" },
  failedLogins: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null },
  passwordChangedAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
});

export const User = model<IUser>("User", schema, "users");
