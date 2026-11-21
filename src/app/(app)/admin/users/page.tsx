import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connectDb } from "@/lib/db/connect";
import { User, type IUser } from "@/lib/db/models/user";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";
import { ROLE_LABELS } from "@/lib/rbac/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/table";
import { UserDialogs, EditUserButton } from "./user-dialogs";

export const metadata: Metadata = { title: "Users & roles" };

export default async function UsersPage() {
  const me = await getSessionUser();
  if (!me || !can(me, "admin.users")) redirect("/dashboard");
  await connectDb();
  const users = await User.find().sort({ name: 1 }).lean<IUser[]>();
  const leads = users.filter((u) => u.active).map((u) => ({ id: u._id, name: u.name }));

  return (
    <>
      <PageHeader
        title="Users & roles"
        description="Create staff accounts, assign roles and grant sensitive-field access. Every change is audit-logged."
        actions={<UserDialogs leads={leads} />}
      />
      <Card>
        <TableWrap>
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Email</TH>
                <TH>Role</TH>
                <TH>Status</TH>
                <TH>Last sign-in</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <tbody>
              {users.map((u) => (
                <TR key={u._id}>
                  <TD className="font-medium">{u.name}</TD>
                  <TD className="text-muted-foreground">{u.email}</TD>
                  <TD>
                    <Badge tone="primary">{ROLE_LABELS[u.role]}</Badge>
                    {u.extraPermissions.length > 0 && (
                      <Badge tone="warning" className="ml-1.5">
                        +{u.extraPermissions.length} granted
                      </Badge>
                    )}
                  </TD>
                  <TD>{u.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Disabled</Badge>}</TD>
                  <TD className="text-muted-foreground">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("en-US") : "Never"}
                  </TD>
                  <TD className="text-right">
                    <EditUserButton
                      user={{
                        id: u._id,
                        name: u.name,
                        email: u.email,
                        role: u.role,
                        active: u.active,
                        teamLeadId: u.teamLeadId ?? "",
                        extraPermissions: u.extraPermissions,
                        isSelf: u._id === me.id,
                      }}
                      leads={leads.filter((l) => l.id !== u._id)}
                    />
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>
    </>
  );
}
