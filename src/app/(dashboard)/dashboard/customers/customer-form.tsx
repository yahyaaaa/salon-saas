"use client";

import { useActionState } from "react";

import { saveCustomerAction, type CustomerFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input } from "@/components/ui";
import { EditDisclosure } from "@/components/edit-disclosure";
import type { CustomerRow } from "@/lib/types/database";

export function CustomerForm({ customer }: { customer?: CustomerRow }) {
  const [state, formAction] = useActionState<CustomerFormState, FormData>(
    saveCustomerAction,
    {},
  );
  const isEdit = Boolean(customer);
  const uid = customer?.id ?? "new";

  const body = (
    <form action={formAction} className="space-y-4">
      {customer ? <input type="hidden" name="customerId" value={customer.id} /> : null}

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" htmlFor={`cust-name-${uid}`} error={state.errors?.fullName}>
          <Input id={`cust-name-${uid}`} name="fullName" defaultValue={customer?.full_name} required />
        </Field>

        <Field
          label="Phone"
          htmlFor={`cust-phone-${uid}`}
          error={state.errors?.phone}
          hint="How this customer is looked up."
        >
          <Input
            id={`cust-phone-${uid}`}
            name="phone"
            type="tel"
            defaultValue={customer?.phone}
            required
            placeholder="+92 300 1234567"
          />
        </Field>

        <Field label="Email (optional)" htmlFor={`cust-email-${uid}`} error={state.errors?.email}>
          <Input
            id={`cust-email-${uid}`}
            name="email"
            type="email"
            defaultValue={customer?.email ?? ""}
          />
        </Field>

        <Field
          label="Date of birth (optional)"
          htmlFor={`cust-dob-${uid}`}
          error={state.errors?.dateOfBirth}
        >
          <Input
            id={`cust-dob-${uid}`}
            name="dateOfBirth"
            type="date"
            defaultValue={customer?.date_of_birth ?? ""}
          />
        </Field>
      </div>

      <Field
        label="Notes"
        htmlFor={`cust-notes-${uid}`}
        error={state.errors?.notes}
        hint="Preferences and reminders. Medical history belongs on a consent form, not here."
      >
        <textarea
          id={`cust-notes-${uid}`}
          name="notes"
          rows={3}
          defaultValue={customer?.notes}
          className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25 focus:outline-none"
        />
      </Field>

      <SubmitButton pendingLabel="Saving...">
        {isEdit ? "Save changes" : "Add customer"}
      </SubmitButton>
    </form>
  );

  if (!isEdit) return body;
  return <EditDisclosure label="Edit profile">{body}</EditDisclosure>;
}
