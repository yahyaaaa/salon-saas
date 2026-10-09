"use client";

import { useActionState } from "react";

import { voidReceiptAction, type PosFormState } from "../actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input } from "@/components/ui";

export function VoidReceiptForm({ receiptId }: { receiptId: string }) {
  const [state, formAction] = useActionState<PosFormState, FormData>(voidReceiptAction, {});

  if (state.success) return <Alert tone="success">{state.success}</Alert>;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="receiptId" value={receiptId} />

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field
        label="Reason"
        htmlFor="void-reason"
        error={state.errors?.reason}
        hint="Required, and kept on the audit log."
      >
        <Input
          id="void-reason"
          name="reason"
          required
          minLength={3}
          placeholder="Charged to the wrong customer"
        />
      </Field>

      <SubmitButton variant="danger" pendingLabel="Voiding...">
        Void receipt
      </SubmitButton>
    </form>
  );
}
