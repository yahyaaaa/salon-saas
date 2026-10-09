"use client";

import { useActionState } from "react";

import { updateAccountAction, type AccountFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input } from "@/components/ui";

export function AccountForm({
  email,
  fullName,
  phone,
}: {
  email: string;
  fullName: string;
  phone: string;
}) {
  const [state, formAction] = useActionState<AccountFormState, FormData>(
    updateAccountAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" htmlFor="fullName" error={state.errors?.fullName}>
          <Input id="fullName" name="fullName" defaultValue={fullName} required />
        </Field>

        <Field label="Phone" htmlFor="phone" error={state.errors?.phone}>
          <Input id="phone" name="phone" type="tel" defaultValue={phone} />
        </Field>
      </div>

      <Field label="Email" htmlFor="email" hint="Contact your salon owner to change this.">
        <Input id="email" value={email} disabled readOnly />
      </Field>

      <SubmitButton pendingLabel="Saving...">Save</SubmitButton>
    </form>
  );
}
