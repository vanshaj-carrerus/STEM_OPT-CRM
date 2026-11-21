"use client";

import { useActionState, useState } from "react";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, FormAlert, Input, Select, SubmitButton } from "@/components/ui/form";
import { PERMISSIONS, ROLES, ROLE_LABELS, type Permission, type Role } from "@/lib/rbac/permissions";
import { createUserAction, resetUserPasswordAction, updateUserAction, type UserFormState } from "./actions";

type Lead = { id: string; name: string };

function TempPassword({ email, password }: { email?: string; password: string }) {
  return (
    <div className="space-y-2 rounded-md border border-warning/40 bg-warning-bg p-3 text-sm">
      <p className="font-medium text-warning">Temporary password (shown once)</p>
      <p>
        Share securely with <span className="font-medium">{email}</span>. They must change it at first sign-in.
      </p>
      <code className="block select-all rounded bg-card px-2 py-1.5 font-mono text-sm">{password}</code>
    </div>
  );
}

function CreateForm({ leads, onDone }: { leads: Lead[]; onDone: () => void }) {
  const [state, action] = useActionState<UserFormState, FormData>(createUserAction, {});
  if (state.ok && state.tempPassword) {
    return (
      <div className="space-y-4">
        <TempPassword email={state.email} password={state.tempPassword} />
        <Button onClick={onDone} className="w-full">
          Done
        </Button>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-4">
      <FormAlert error={state.error} />
      <Field label="Full name" htmlFor="name" required>
        <Input id="name" name="name" required />
      </Field>
      <Field label="Work email" htmlFor="email" required>
        <Input id="email" name="email" type="email" required />
      </Field>
      <Field label="Role" htmlFor="role" required>
        <Select id="role" name="role" defaultValue="compliance_associate" required>
          {ROLES.filter((r) => r !== "candidate_portal").map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Team lead (escalation)" htmlFor="teamLeadId" hint="Overdue tasks escalate owner → team lead → compliance manager → admin.">
        <Select id="teamLeadId" name="teamLeadId" defaultValue="">
          <option value="">— none —</option>
          {leads.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>
      <SubmitButton className="w-full" pendingText="Creating…">
        Create user
      </SubmitButton>
    </form>
  );
}

export function UserDialogs({ leads }: { leads: Lead[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" /> New user
        </Button>
      </DialogTrigger>
      <DialogContent title="Create user" description="A temporary password is generated; the user is forced to change it and sign in with an emailed code.">
        {open && <CreateForm leads={leads} onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

interface EditableUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  teamLeadId: string;
  extraPermissions: Permission[];
  isSelf: boolean;
}

const SENSITIVE_GRANTABLE = PERMISSIONS.filter((p) => p.startsWith("sensitive."));

function EditForm({ user, leads }: { user: EditableUser; leads: Lead[] }) {
  const [state, action] = useActionState<UserFormState, FormData>(updateUserAction, {});
  const [reset, resetAction] = useActionState<UserFormState, FormData>(resetUserPasswordAction, {});
  return (
    <div className="space-y-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="id" value={user.id} />
        <FormAlert error={state.error} message={state.ok ? "Saved." : undefined} />
        <Field label="Role" htmlFor="role">
          <Select id="role" name="role" defaultValue={user.role} disabled={user.isSelf}>
            {ROLES.filter((r) => r !== "candidate_portal").map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
          {user.isSelf && <input type="hidden" name="role" value={user.role} />}
        </Field>
        <Field label="Team lead" htmlFor="teamLeadId">
          <Select id="teamLeadId" name="teamLeadId" defaultValue={user.teamLeadId}>
            <option value="">— none —</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Sensitive field access (logged when used)</legend>
          {SENSITIVE_GRANTABLE.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="extraPermissions" value={p} defaultChecked={user.extraPermissions.includes(p)} />
              {p.replace("sensitive.", "").replace(".view", "")}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={user.active} disabled={user.isSelf} />
          Account active
          {user.isSelf && <input type="hidden" name="active" value="on" />}
        </label>
        <SubmitButton className="w-full">Save changes</SubmitButton>
      </form>
      <form action={resetAction} className="border-t pt-4">
        <input type="hidden" name="id" value={user.id} />
        {reset.ok && reset.tempPassword && <TempPassword email={reset.email} password={reset.tempPassword} />}
        <FormAlert error={reset.error} />
        {!reset.ok && (
          <SubmitButton variant="outline" className="w-full" pendingText="Resetting…">
            Reset password &amp; sign out everywhere
          </SubmitButton>
        )}
      </form>
    </div>
  );
}

export function EditUserButton({ user, leads }: { user: EditableUser; leads: Lead[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent title={user.name} description={user.email}>
        {open && <EditForm user={user} leads={leads} />}
      </DialogContent>
    </Dialog>
  );
}
