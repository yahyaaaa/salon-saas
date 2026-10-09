"use client";

import { useActionState } from "react";

import { saveTeamMemberAction, type TeamFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input } from "@/components/ui";
import type { TeamMemberRow } from "@/lib/types/database";

/**
 * Adding someone to the roster.
 *
 * A name and, optionally, what they do. Deliberately no email field: most of a
 * salon floor never signs in, and requiring an address for them would either
 * block the owner from recording who works there or fill the auth system with
 * invented accounts. A login is attached separately, and only when wanted.
 */
export function RosterForm({ member }: { member?: TeamMemberRow }) {
  const [state, formAction] = useActionState<TeamFormState, FormData>(
    saveTeamMemberAction,
    {},
  );

  const id = member?.id ?? "new";

  return (
    <form action={formAction} className="space-y-3">
      {member ? <input type="hidden" name="memberId" value={member.id} /> : null}

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      {/*
        A grid rather than flex-wrap: the two fields share a row on anything
        above a phone, and stack below it, without depending on the controls'
        intrinsic widths. `items-start` keeps the button aligned with the
        inputs even when Specialty renders its hint underneath.
      */}
      <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Field label="Name" htmlFor={`member-name-${id}`} error={state.errors?.fullName}>
          <Input
            id={`member-name-${id}`}
            name="fullName"
            defaultValue={member?.full_name ?? ""}
            required
            placeholder="Hafsa"
          />
        </Field>

        <Field
          label="Specialty"
          htmlFor={`member-specialty-${id}`}
          error={state.errors?.specialty}
          hint="Optional."
        >
          <Input
            id={`member-specialty-${id}`}
            name="specialty"
            defaultValue={member?.specialty ?? ""}
            placeholder="Hair colour, bridal"
          />
        </Field>

        {/* Nudged down by the height of a field label, so it lines up with
            the inputs rather than with their captions. */}
        <div className="sm:mt-[1.625rem]">
          <SubmitButton variant={member ? "secondary" : "primary"} size="sm" pendingLabel="Saving...">
            {member ? "Save" : "Add to the team"}
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}
