"use client";

import { useActionState } from "react";

import {
  advanceStatusAction,
  rescheduleAction,
  resolveAppointmentAction,
  type BookingFormState,
} from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { EditDisclosure } from "@/components/edit-disclosure";
import { Alert, Button, Field, Input, Select } from "@/components/ui";
import type { AppointmentStatus } from "@/lib/types/database";

const TERMINAL: AppointmentStatus[] = ["completed", "cancelled", "no_show"];

export function AppointmentActions({
  appointmentId,
  status,
  staffId,
  date,
  time,
  therapists,
}: {
  appointmentId: string;
  status: AppointmentStatus;
  staffId: string;
  date: string;
  time: string;
  therapists: { id: string; name: string }[];
}) {
  // A finished appointment is a record, not a to-do: the database rejects
  // further transitions, so nothing is offered here either.
  if (TERMINAL.includes(status)) {
    return <span className="text-xs text-ink-400">No further changes</span>;
  }

  return (
    <div className="flex flex-wrap items-start gap-2">
      {status === "booked" ? (
        <form action={advanceStatusAction}>
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <input type="hidden" name="status" value="confirmed" />
          <Button type="submit" variant="secondary" size="sm">
            Confirm
          </Button>
        </form>
      ) : null}

      <form action={advanceStatusAction}>
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <input type="hidden" name="status" value="completed" />
        <Button type="submit" variant="primary" size="sm">
          Complete
        </Button>
      </form>

      <EditDisclosure label="Move">
        <RescheduleForm
          appointmentId={appointmentId}
          staffId={staffId}
          date={date}
          time={time}
          therapists={therapists}
        />
      </EditDisclosure>

      <EditDisclosure label="Cancel / no-show">
        <ResolveForm appointmentId={appointmentId} />
      </EditDisclosure>
    </div>
  );
}

function RescheduleForm({
  appointmentId,
  staffId,
  date,
  time,
  therapists,
}: {
  appointmentId: string;
  staffId: string;
  date: string;
  time: string;
  therapists: { id: string; name: string }[];
}) {
  const [state, formAction] = useActionState<BookingFormState, FormData>(rescheduleAction, {});

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="appointmentId" value={appointmentId} />

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <Field label="Team member" htmlFor={`move-staff-${appointmentId}`} error={state.errors?.staffId}>
        <Select id={`move-staff-${appointmentId}`} name="staffId" defaultValue={staffId}>
          {therapists.map((therapist) => (
            <option key={therapist.id} value={therapist.id}>
              {therapist.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" htmlFor={`move-date-${appointmentId}`} error={state.errors?.date}>
          <Input id={`move-date-${appointmentId}`} name="date" type="date" defaultValue={date} required />
        </Field>
        <Field label="Time" htmlFor={`move-time-${appointmentId}`} error={state.errors?.time}>
          <Input
            id={`move-time-${appointmentId}`}
            name="time"
            type="time"
            step="300"
            defaultValue={time}
            required
          />
        </Field>
      </div>

      <p className="text-xs text-ink-500">The appointment keeps its current length.</p>

      <SubmitButton size="sm" pendingLabel="Moving...">
        Move appointment
      </SubmitButton>
    </form>
  );
}

function ResolveForm({ appointmentId }: { appointmentId: string }) {
  const [state, formAction] = useActionState<BookingFormState, FormData>(
    resolveAppointmentAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="appointmentId" value={appointmentId} />

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <Field label="Outcome" htmlFor={`resolve-status-${appointmentId}`} error={state.errors?.status}>
        <Select id={`resolve-status-${appointmentId}`} name="status" defaultValue="cancelled">
          <option value="cancelled">Cancelled</option>
          <option value="no_show">No-show</option>
        </Select>
      </Field>

      <Field
        label="Reason"
        htmlFor={`resolve-reason-${appointmentId}`}
        error={state.errors?.reason}
        hint="Required. This feeds the reporting in Phase 6."
      >
        <Input
          id={`resolve-reason-${appointmentId}`}
          name="reason"
          required
          minLength={3}
          placeholder="Customer rang to cancel"
        />
      </Field>

      <SubmitButton size="sm" variant="danger" pendingLabel="Recording...">
        Record outcome
      </SubmitButton>
    </form>
  );
}
