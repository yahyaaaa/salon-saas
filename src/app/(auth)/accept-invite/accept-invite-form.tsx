"use client";

import { useActionState } from "react";

import { acceptInviteAction, type FormState } from "../actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input } from "@/components/ui";

export function AcceptInviteForm({ defaultName }: { defaultName: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(acceptInviteAction, {});

  return (
    <form action={formAction} className="space-y-4">
      {state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field label="Your name" htmlFor="fullName" error={state.errors?.fullName}>
        <Input
          id="fullName"
          name="fullName"
          autoComplete="name"
          defaultValue={defaultName}
          required
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        error={state.errors?.password}
        hint="At least 8 characters."
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
      </Field>

      <Field
        label="Confirm password"
        htmlFor="confirmPassword"
        error={state.errors?.confirmPassword}
      >
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
        />
      </Field>

      <SubmitButton className="w-full" pendingLabel="Setting up...">
        Finish setup
      </SubmitButton>
    </form>
  );
}
