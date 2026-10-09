"use client";

import { useActionState } from "react";

import {
  recordPaymentAction,
  refundPaymentAction,
  type BookingFormState,
} from "../actions";
import { SubmitButton } from "@/components/submit-button";
import { EditDisclosure } from "@/components/edit-disclosure";
import { Alert, Field, Input, Select } from "@/components/ui";
import { formatMoney } from "@/lib/format";

/**
 * Taking an advance, an instalment, or the balance in cash at the desk.
 *
 * Nothing here decides how much is owed -- `record_payment()` reads the
 * appointment's own balance and refuses anything that would take the total
 * past it, so two receptionists taking a deposit at the same moment cannot
 * between them overshoot.
 */
export function RecordPaymentForm({
  appointmentId,
  outstanding,
  currency,
  today,
}: {
  appointmentId: string;
  outstanding: number;
  currency: string;
  today: string;
}) {
  const [state, formAction] = useActionState<BookingFormState, FormData>(
    recordPaymentAction,
    {},
  );

  const was = (name: string, fallback = "") => state.values?.[name] ?? fallback;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="appointmentId" value={appointmentId} />

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label={`Amount (${currency})`}
          htmlFor="payment-amount"
          error={state.errors?.amount}
          hint={
            outstanding > 0
              ? `${formatMoney(outstanding, currency)} still to pay`
              : "Nothing is outstanding"
          }
        >
          <Input
            id="payment-amount"
            name="amount"
            type="number"
            step="0.01"
            min="0"
            max={outstanding > 0 ? outstanding : undefined}
            defaultValue={was("amount")}
            placeholder="0.00"
            required
          />
        </Field>

        <Field label="Method" htmlFor="payment-method" error={state.errors?.method}>
          <Select id="payment-method" name="method" defaultValue={was("method", "cash")}>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="other">Other</option>
          </Select>
        </Field>

        {/*
          The date the money changed hands, which is not always today: a
          deposit taken on Saturday may only be entered on Monday, and the
          daily takings report reads this rather than when it was typed.
        */}
        <Field
          label="Received on"
          htmlFor="payment-date"
          error={state.errors?.paidOn}
          hint="Leave as today unless you are catching up."
        >
          <Input
            id="payment-date"
            name="paidOn"
            type="date"
            max={today}
            defaultValue={was("paidOn", today)}
          />
        </Field>

        <Field label="Note" htmlFor="payment-note" error={state.errors?.note}>
          <Input
            id="payment-note"
            name="note"
            maxLength={500}
            defaultValue={was("note")}
            placeholder="e.g. 20% advance"
          />
        </Field>
      </div>

      <SubmitButton size="sm" pendingLabel="Recording...">
        Record payment
      </SubmitButton>
    </form>
  );
}

/**
 * Giving one back.
 *
 * A reversing entry, never a deletion -- the money did arrive, and the
 * customer's own record of it will say so. Owner-only, with a reason, on the
 * same footing as voiding a receipt.
 */
export function RefundPaymentForm({
  paymentId,
  appointmentId,
  amount,
  currency,
}: {
  paymentId: string;
  appointmentId: string;
  amount: number;
  currency: string;
}) {
  const [state, formAction] = useActionState<BookingFormState, FormData>(
    refundPaymentAction,
    {},
  );

  return (
    <EditDisclosure label="Refund">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="paymentId" value={paymentId} />
        <input type="hidden" name="appointmentId" value={appointmentId} />

        {state.message ? <Alert tone="error">{state.message}</Alert> : null}
        {state.success ? <Alert tone="success">{state.success}</Alert> : null}

        <p className="text-xs text-ink-600">
          Gives back {formatMoney(amount, currency)}. The original payment stays on the
          record with the refund beside it.
        </p>

        <Field label="Reason" htmlFor={`refund-${paymentId}`} error={state.errors?.reason}>
          <Input
            id={`refund-${paymentId}`}
            name="reason"
            required
            minLength={3}
            placeholder="Customer cancelled"
          />
        </Field>

        <SubmitButton size="sm" variant="danger" pendingLabel="Refunding...">
          Refund this payment
        </SubmitButton>
      </form>
    </EditDisclosure>
  );
}
