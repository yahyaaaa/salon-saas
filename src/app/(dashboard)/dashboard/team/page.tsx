import type { Metadata } from "next";

import {
  changeRoleAction,
  deleteRoleAction,
  linkLoginAction,
  revokeInviteAction,
  setActiveAction,
  setTeamMemberActiveAction,
} from "./actions";
import { IdDocument } from "./id-document";
import { InviteForm } from "./invite-form";
import { RoleForm } from "./role-form";
import { RosterForm } from "./roster-form";
import { MODULES } from "@/lib/modules";
import { requireModule } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { EditDisclosure } from "@/components/edit-disclosure";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Select,
} from "@/components/ui";
import type {
  AppModule,
  InvitationRow,
  ProfileRow,
  RoleModuleRow,
  RoleRow,
  StaffDocumentRow,
  TeamMemberRow,
} from "@/lib/types/database";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const session = await requireModule("team");
  const supabase = await createClient();

  const [
    { data: roster },
    { data: members },
    { data: invitations },
    { data: documents },
    { data: roleRows },
    { data: roleModuleRows },
  ] = await Promise.all([
      supabase.from("team_members").select("*").order("is_active", { ascending: false }).order("full_name"),
      supabase
        .from("profiles")
        .select("*")
        .order("is_active", { ascending: false })
        .order("created_at", { ascending: true }),
      supabase
        .from("invitations")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      // Owner-only by policy as well as by this page's guard.
      supabase.from("staff_documents").select("*").eq("doc_type", "id_card"),
      supabase.from("roles").select("*").order("is_owner", { ascending: false }).order("name"),
      supabase.from("role_modules").select("*"),
    ]);

  const team = (roster ?? []) as TeamMemberRow[];
  const logins = (members ?? []) as ProfileRow[];
  const roles = (roleRows ?? []) as RoleRow[];

  const modulesByRole = new Map<string, AppModule[]>();
  for (const row of (roleModuleRows ?? []) as RoleModuleRow[]) {
    modulesByRole.set(row.role_id, [...(modulesByRole.get(row.role_id) ?? []), row.module]);
  }

  const roleById = new Map<string, RoleRow>();
  for (const r of roles) roleById.set(r.id, r);

  // How many logins hold each role, so a role in use is not offered for
  // deletion with no explanation.
  const holders = new Map<string, number>();
  for (const p of logins) {
    if (p.role_id) holders.set(p.role_id, (holders.get(p.role_id) ?? 0) + 1);
  }

  const moduleLabel = new Map(MODULES.map((m) => [m.module, m.label]));

  /** The owner role is never offered: it is not a permission setting. */
  const assignable = roles.filter((r) => !r.is_owner);

  const documentByStaff = new Map<string, StaffDocumentRow>();
  for (const row of (documents ?? []) as StaffDocumentRow[]) {
    documentByStaff.set(row.staff_id, row);
  }

  // Which roster entries already have an account, so neither list has to be
  // read twice to answer "can this person sign in?".
  const loginByMember = new Map<string, ProfileRow>();
  for (const p of logins) {
    if (p.team_member_id) loginByMember.set(p.team_member_id, p);
  }

  const unlinked = team.filter((m) => !loginByMember.has(m.id));

  return (
    <>
      <PageHeader
        title="Team"
        description="Who works here, and who can sign in. They are deliberately not the same list."
      />

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Add to the team"
          description="A name is enough. No email is needed — someone only needs an account if they want to sign in and check their own earnings."
        />
        <div className="px-5 py-4">
          <RosterForm />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="The team"
          description="Who performs services and who payroll pays. Taking someone off the team keeps their history — bookings, receipts and payslips all stay intact."
        />

        {team.length === 0 ? (
          <EmptyState>Nobody on the team yet. Add your first person above.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {team.map((member) => {
              const login = loginByMember.get(member.id);
              return (
                <li key={member.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900">
                        <span className="truncate">{member.full_name}</span>
                        {!member.is_active ? <Badge tone="danger">Off the team</Badge> : null}
                        {login ? (
                          <Badge tone="brand">Can sign in</Badge>
                        ) : (
                          <Badge tone="neutral">No login</Badge>
                        )}
                      </p>
                      {member.specialty ? (
                        <p className="mt-0.5 text-xs text-ink-500">{member.specialty}</p>
                      ) : null}
                      {login ? (
                        <p className="mt-0.5 text-xs text-ink-500">
                          {login.email} &middot;{" "}
                          {roleById.get(login.role_id ?? "")?.name ?? "No role"}
                        </p>
                      ) : null}

                      <div className="mt-2 flex flex-wrap gap-2">
                        <EditDisclosure label="Edit">
                          <RosterForm member={member} />
                        </EditDisclosure>
                        <IdDocument
                          staffId={member.id}
                          name={member.full_name}
                          document={documentByStaff.get(member.id)}
                        />
                      </div>
                    </div>

                    <form action={setTeamMemberActiveAction}>
                      <input type="hidden" name="memberId" value={member.id} />
                      <input
                        type="hidden"
                        name="isActive"
                        value={member.is_active ? "false" : "true"}
                      />
                      <Button
                        type="submit"
                        variant={member.is_active ? "danger" : "secondary"}
                        size="sm"
                      >
                        {member.is_active ? "Remove from team" : "Bring back"}
                      </Button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Give someone a login"
          description="An account lets them sign in. They receive an email link to set their own password."
        />
        <div className="px-5 py-4">
          <InviteForm roster={unlinked.filter((m) => m.is_active)} roles={assignable} />
        </div>
      </Card>

      {invitations && invitations.length > 0 ? (
        <Card>
          <CardHeader title="Pending invitations" description="Invitations expire after 7 days." />
          <ul className="divide-y divide-ink-200">
            {invitations.map((invitation: InvitationRow) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-900">{invitation.email}</p>
                  <p className="text-xs text-ink-500">
                    {roleById.get(invitation.role_id ?? "")?.name ?? "No role"} &middot; expires{" "}
                    {new Date(invitation.expires_at).toLocaleDateString()}
                  </p>
                </div>
                <form action={revokeInviteAction}>
                  <input type="hidden" name="invitationId" value={invitation.id} />
                  <Button type="submit" variant="danger" size="sm">
                    Revoke
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Roles"
          description="What each kind of account can reach. Enforced by the database, not just by hiding links — unticking a box removes the data, not only the menu item."
        />

        <ul className="divide-y divide-ink-200">
          {roles.map((role) => {
            const held = modulesByRole.get(role.id) ?? [];
            const inUse = holders.get(role.id) ?? 0;

            return (
              <li key={role.id} className="px-5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900">
                      {role.name}
                      {role.is_owner ? <Badge tone="brand">The owner</Badge> : null}
                      {role.is_system && !role.is_owner ? (
                        <Badge tone="neutral">Built in</Badge>
                      ) : null}
                      <span className="text-xs font-normal text-ink-500">
                        {inUse === 0
                          ? "nobody"
                          : `${inUse} ${inUse === 1 ? "account" : "accounts"}`}
                      </span>
                    </p>

                    <p className="mt-0.5 text-xs text-ink-500">
                      {role.is_owner
                        ? "Everything, including anything added in future. Cannot be renamed, deleted, or given to anyone else."
                        : held.length === 0
                          ? "Nothing beyond their own work — their own diary and their own earnings."
                          : held
                              .map((m) => moduleLabel.get(m) ?? m)
                              .sort()
                              .join(", ")}
                    </p>

                    {!role.is_owner ? (
                      <div className="mt-2">
                        <EditDisclosure label="Edit permissions">
                          <RoleForm role={role} modules={held} />
                        </EditDisclosure>
                      </div>
                    ) : null}
                  </div>

                  {!role.is_owner && !role.is_system && inUse === 0 ? (
                    <form action={deleteRoleAction}>
                      <input type="hidden" name="roleId" value={role.id} />
                      <Button type="submit" variant="danger" size="sm">
                        Delete
                      </Button>
                    </form>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-ink-200 px-5 py-4">
          <EditDisclosure label="Add a role">
            <RoleForm />
          </EditDisclosure>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Accounts"
          description="Removing access deactivates the account rather than deleting it, so bookings, receipts and the audit trail stay intact."
        />

        {logins.length === 0 ? (
          <EmptyState>No accounts yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {logins.map((member) => {
              const isSelf = member.id === session.userId;
              const linked = team.find((m) => m.id === member.team_member_id);

              return (
                <li key={member.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                        <span className="truncate">{member.full_name || member.email}</span>
                        {isSelf ? <Badge tone="brand">You</Badge> : null}
                        {!member.is_active ? <Badge tone="danger">Deactivated</Badge> : null}
                      </p>
                      <p className="truncate text-xs text-ink-500">{member.email}</p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {linked ? (
                          <>On the team as {linked.full_name}</>
                        ) : (
                          /*
                            States the consequence and the remedy rather than
                            passing judgement. An account with no roster entry
                            is a perfectly valid thing -- an administrator, a
                            bookkeeper -- it just cannot be the answer to "who
                            performed this service?".
                          */
                          <span className="text-ink-500">
                            Can sign in, but is not on the team — so cannot be booked or
                            paid. Link them below if they should be.
                          </span>
                        )}
                      </p>

                      {/*
                        Linking is what lets someone see their own earnings:
                        the earnings page reads the ROSTER entry, because that
                        is what appointments and payroll reference.
                      */}
                      <form action={linkLoginAction} className="mt-2 flex flex-wrap items-center gap-2">
                        <input type="hidden" name="profileId" value={member.id} />
                        <label htmlFor={`link-${member.id}`} className="sr-only">
                          Team member for {member.email}
                        </label>
                        <Select
                          id={`link-${member.id}`}
                          name="memberId"
                          defaultValue={member.team_member_id ?? ""}
                          className="w-56 py-1.5 text-xs"
                        >
                          <option value="">Not on the team</option>
                          {team
                            .filter(
                              (m) =>
                                m.id === member.team_member_id ||
                                (!loginByMember.has(m.id) && m.is_active),
                            )
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.full_name}
                              </option>
                            ))}
                        </Select>
                        <Button type="submit" variant="secondary" size="sm">
                          Link
                        </Button>
                      </form>
                    </div>

                    <div className="flex items-center gap-2">
                      {/*
                        The owner's own role is shown but never editable, and
                        the owner role is not in the list for anyone else --
                        it is created with the salon and the database refuses
                        to assign it.
                      */}
                      {isSelf || roleById.get(member.role_id ?? "")?.is_owner ? (
                        <span className="text-sm text-ink-500">
                          {roleById.get(member.role_id ?? "")?.name ?? "No role"}
                        </span>
                      ) : (
                        <form action={changeRoleAction} className="flex items-center gap-2">
                          <input type="hidden" name="profileId" value={member.id} />
                          <label htmlFor={`role-${member.id}`} className="sr-only">
                            Role for {member.full_name || member.email}
                          </label>
                          <Select
                            id={`role-${member.id}`}
                            name="roleId"
                            defaultValue={member.role_id ?? ""}
                            className="w-44 py-1.5 text-xs"
                          >
                            {member.role_id ? null : <option value="">No role</option>}
                            {assignable.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </Select>
                          <Button type="submit" variant="secondary" size="sm">
                            Save
                          </Button>
                        </form>
                      )}

                      {!isSelf ? (
                        <form action={setActiveAction}>
                          <input type="hidden" name="profileId" value={member.id} />
                          <input
                            type="hidden"
                            name="isActive"
                            value={member.is_active ? "false" : "true"}
                          />
                          <Button
                            type="submit"
                            variant={member.is_active ? "danger" : "secondary"}
                            size="sm"
                          >
                            {member.is_active ? "Deactivate" : "Reactivate"}
                          </Button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
