"use client";

import { useActionState } from "react";

import { generatePayrollAction, type PayrollFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input } from "@/components/ui";

export function GeneratePayrollForm() {
  const [state, formAction] = useActionState<PayrollFormState, FormData>(
    generatePayrollAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="From" htmlFor="payroll-from" error={state.errors?.startsOn}>
          <Input id="payroll-from" name="startsOn" type="date" required />
        </Field>
        <Field label="To" htmlFor="payroll-to" error={state.errors?.endsOn}>
          <Input id="payroll-to" name="endsOn" type="date" required />
        </Field>
        <Field label="Notes" htmlFor="payroll-notes" error={state.errors?.notes}>
          <Input id="payroll-notes" name="notes" placeholder="Optional" />
        </Field>
      </div>

      <SubmitButton pendingLabel="Calculating...">Generate period</SubmitButton>
    </form>
  );
}
