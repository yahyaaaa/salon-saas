"use client";

import { useActionState, useMemo, useState } from "react";

import { editAppointmentAction, type BookingFormState } from "../actions";
import { SubmitButton } from "@/components/submit-button";
import { ServicePicker } from "@/components/service-picker";
import { toPickable } from "@/lib/services";
import { Alert, Button, Field, Input } from "@/components/ui";
import { formatDuration, formatMoney } from "@/lib/format";
import type { AppointmentServiceRow, ServiceRow } from "@/lib/types/database";

interface Line {
  key: string;
  serviceId: string;
  quantity: number;
}

/**
 * Changing what is on a booking after it has been made.
 *
 * Everything shown here is an estimate for the desk.
 * `update_appointment_services()` recomputes the subtotal, the slot length and
 * the agreed price from the catalogue, re-runs the therapist-qualification
 * check, and refuses a price below what the customer has already paid.
 */
export function ServicesEditor({
  appointmentId,
  services,
  booked,
  discount: bookedDiscount,
  quotedTotal: bookedQuoted,
  currency,
}: {
  appointmentId: string;
  services: ServiceRow[];
  booked: AppointmentServiceRow[];
  discount: number;
  quotedTotal: number | null;
  currency: string;
}) {
  const [state, formAction] = useActionState<BookingFormState, FormData>(
    editAppointmentAction,
    {},
  );

  const pickable = useMemo(() => toPickable(services), [services]);
  const byId = useMemo(() => new Map(pickable.map((s) => [s.id, s])), [pickable]);

  const [lines, setLines] = useState<Line[]>(() =>
    booked.map((line, index) => ({
      key: `booked-${index}`,
      serviceId: line.service_id,
      quantity: line.quantity,
    })),
  );
  const [discount, setDiscount] = useState(String(bookedDiscount ?? 0));
  const [quotedTotal, setQuotedTotal] = useState(
    bookedQuoted === null ? "" : String(bookedQuoted),
  );

  function addServices(ids: string[]) {
    setLines((current) => {
      const next = [...current];
      for (const id of ids) {
        const existing = next.find((l) => l.serviceId === id);
        if (existing) existing.quantity = Math.min(20, existing.quantity + 1);
        else next.push({ key: `${id}-${Date.now()}-${next.length}`, serviceId: id, quantity: 1 });
      }
      return next;
    });
  }

  function setQuantity(key: string, quantity: number) {
    setLines((current) =>
      current.map((l) =>
        l.key === key ? { ...l, quantity: Math.max(1, Math.min(20, quantity)) } : l,
      ),
    );
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((l) => l.key !== key));
  }

  const subtotal = lines.reduce((sum, line) => {
    const service = byId.get(line.serviceId);
    return sum + (service ? service.price * line.quantity : 0);
  }, 0);
  const minutes = lines.reduce((sum, line) => {
    const service = byId.get(line.serviceId);
    return sum + (service ? service.duration_minutes * line.quantity : 0);
  }, 0);

  const discountValue = Math.max(0, Number(discount) || 0);
  const overridden = quotedTotal.trim() !== "";
  const total = overridden
    ? Math.max(0, Number(quotedTotal) || 0)
    : Math.max(0, Math.round((subtotal - discountValue) * 100) / 100);

  const linesJson = JSON.stringify(
    lines.map((l) => ({ serviceId: l.serviceId, quantity: l.quantity })),
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="lines" value={linesJson} />

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <div>
        <ServicePicker
          services={pickable}
          currency={currency}
          onAdd={addServices}
          label="Services on this booking"
        />
        {state.errors?.lines ? (
          <p className="mt-1 text-xs font-medium text-red-600">{state.errors.lines}</p>
        ) : null}

        {lines.length > 0 ? (
          <ul className="mt-3 divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white">
            {lines.map((line) => {
              const service = byId.get(line.serviceId);
              return (
                <li key={line.key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 text-sm text-ink-800">
                    {service?.name ?? "Service"}
                    <span className="ml-2 text-xs text-ink-400">{service?.category}</span>
                  </span>
                  <label className="flex items-center gap-1.5 text-xs text-ink-500">
                    Qty
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={line.quantity}
                      onChange={(event) => setQuantity(line.key, Number(event.target.value) || 1)}
                      className="w-16"
                      aria-label={`Quantity of ${service?.name ?? "service"}`}
                    />
                  </label>
                  <span className="w-24 text-right text-sm tabular-nums text-ink-700">
                    {formatMoney(service ? service.price * line.quantity : 0, currency)}
                  </span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeLine(line.key)}>
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-ink-500">Add at least one service.</p>
        )}

        {minutes > 0 ? (
          <p className="mt-2 text-xs text-ink-500">
            The slot becomes {formatDuration(minutes)}. If that runs into another
            booking, the save will be refused.
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={`Discount (${currency})`}
          htmlFor="edit-discount"
          error={state.errors?.discount}
          hint="Taken off the calculated subtotal."
        >
          <Input
            id="edit-discount"
            name="discount"
            type="number"
            step="0.01"
            min="0"
            value={discount}
            onChange={(event) => setDiscount(event.target.value)}
            disabled={overridden}
          />
        </Field>

        <Field
          label={`Quoted total (${currency})`}
          htmlFor="edit-quoted"
          error={state.errors?.quotedTotal}
          hint="Leave blank to add the services up."
        >
          <Input
            id="edit-quoted"
            name="quotedTotal"
            type="number"
            step="0.01"
            min="0"
            value={quotedTotal}
            onChange={(event) => setQuotedTotal(event.target.value)}
            placeholder={formatMoney(subtotal - discountValue, currency)}
          />
        </Field>
      </div>

      <dl className="space-y-1 rounded-lg bg-ink-50 px-4 py-3 text-sm">
        <div className="flex justify-between text-ink-600">
          <dt>Services subtotal</dt>
          <dd className="tabular-nums">{formatMoney(subtotal, currency)}</dd>
        </div>
        {!overridden && discountValue > 0 ? (
          <div className="flex justify-between text-ink-600">
            <dt>Discount</dt>
            <dd className="tabular-nums">&minus; {formatMoney(discountValue, currency)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between border-t border-ink-200 pt-1.5 text-base font-semibold text-ink-900">
          <dt>{overridden ? "Quoted price" : "New total"}</dt>
          <dd className="tabular-nums">{formatMoney(total, currency)}</dd>
        </div>
      </dl>

      <SubmitButton pendingLabel="Saving...">Save changes</SubmitButton>
    </form>
  );
}
