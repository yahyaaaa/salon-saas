"use client";

import { useActionState } from "react";

import { inviteMemberAction, type TeamFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input, Select } from "@/components/ui";
import type { RoleRow, TeamMemberRow } from "@/lib/types/database";

/**
 * Creating a login.
 *
 * The account can belong to someone already on the team -- "give Hafsa a
 * login" -- or stand alone for an administrator who manages the salon but
 * performs no services. The third option makes a fresh roster entry, which is
 * what every invitation did implicitly before the Team/User split.
 */
export function InviteForm({
  roster,
  roles,
}: {
  roster: TeamMemberRow[];
  roles: RoleRow[];
}) {
  const [state, formAction] = useActionState<TeamFormState, FormData>(
    inviteMemberAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Email" htmlFor="invite-email" error={state.errors?.email}>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder="therapist@salon.com"
          />
        </Field>

        <Field label="Name" htmlFor="invite-name" error={state.errors?.fullName}>
          <Input id="invite-name" name="fullName" placeholder="Optional" />
        </Field>

        {/*
          The salon's own roles. The owner role is not among them -- it is
          created with the salon and the database refuses to assign it, so
          offering it here would only produce a confusing failure.
        */}
        <Field label="Role" htmlFor="invite-role" error={state.errors?.roleId}>
          <Select id="invite-role" name="roleId" defaultValue="" required>
            <option value="" disabled>
              Choose a role
            </option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="This account belongs to"
        htmlFor="invite-member"
        error={state.errors?.teamMemberId}
        hint="Only people without a login are listed."
      >
        <Select id="invite-member" name="teamMemberId" defaultValue="">
          <option value="">Someone new — add them to the team</option>
          {roster.map((member) => (
            <option key={member.id} value={member.id}>
              {member.full_name}
              {member.specialty ? ` — ${member.specialty}` : ""}
            </option>
          ))}
          <option value="none">Nobody — an admin who performs no services</option>
        </Select>
      </Field>

      <SubmitButton pendingLabel="Sending invitation...">Send invitation</SubmitButton>
    </form>
  );
}
