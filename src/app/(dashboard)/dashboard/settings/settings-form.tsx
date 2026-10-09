"use client";

import { useActionState } from "react";

import { updateSettingsAction, type SettingsFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, CardHeader, Field, Input, Select } from "@/components/ui";
import { LocaleFields } from "@/components/locale-fields";
import type { BusinessHours, SalonRow } from "@/lib/types/database";

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;

export function SettingsForm({
  salon,
  loyaltyEarnRate,
  businessHours,
}: {
  salon: SalonRow;
  loyaltyEarnRate: number;
  businessHours: BusinessHours;
}) {
  const [state, formAction] = useActionState<SettingsFormState, FormData>(
    updateSettingsAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-6">
      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <Card>
        <CardHeader title="Business details" />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <Field label="Salon name" htmlFor="salonName" error={state.errors?.salonName}>
            <Input
              id="salonName"
              name="salonName"
              defaultValue={state.values?.salonName ?? salon.name}
              required
            />
          </Field>

          <Field label="Business type" htmlFor="businessType" error={state.errors?.businessType}>
            <Select
              id="businessType"
              name="businessType"
              defaultValue={state.values?.businessType ?? salon.business_type}
            >
              <option value="salon">Salon</option>
              <option value="aesthetic_clinic">Aesthetic clinic</option>
            </Select>
          </Field>

        </div>

        <div className="border-t border-ink-200 px-5 py-4">
          <LocaleFields
            idPrefix="settings"
            defaultCountry={state.values?.country ?? salon.country}
            defaultCurrency={state.values?.currency ?? salon.currency}
            defaultTimezone={state.values?.timezone ?? salon.timezone}
            errors={state.errors ?? {}}
          />
          <p className="mt-2 text-xs text-ink-500">
            Appointments, receipts and every report are counted in this timezone.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Loyalty programme"
          description="Points are held as a currency balance, not an abstract count."
        />
        <div className="px-5 py-4 sm:max-w-sm">
          <Field
            label="Earn rate"
            htmlFor="loyaltyEarnRatePercent"
            error={state.errors?.loyaltyEarnRatePercent}
            hint={`At ${(loyaltyEarnRate * 100).toFixed(2)}%, a 50 ${salon.currency} bill credits ${(50 * loyaltyEarnRate).toFixed(2)} ${salon.currency}.`}
          >
            <div className="flex items-center gap-2">
              <Input
                id="loyaltyEarnRatePercent"
                name="loyaltyEarnRatePercent"
                type="number"
                step="0.01"
                min="0"
                max="100"
                defaultValue={(loyaltyEarnRate * 100).toFixed(2)}
                required
              />
              <span className="text-sm text-ink-500">% of bill</span>
            </div>
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Business hours"
          description="Used to bound the booking calendar in Phase 3."
        />
        <ul className="divide-y divide-ink-200">
          {DAYS.map(([key, label]) => {
            const day = businessHours[key];
            return (
              <li key={key} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="w-24 text-sm font-medium text-ink-700">{label}</span>

                <label className="flex items-center gap-2 text-sm text-ink-600">
                  <input
                    type="checkbox"
                    name={`hours.${key}.closed`}
                    defaultChecked={day.closed}
                    className="size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                  />
                  Closed
                </label>

                <div className="flex items-center gap-2">
                  <label htmlFor={`hours-${key}-open`} className="sr-only">
                    {label} opening time
                  </label>
                  <Input
                    id={`hours-${key}-open`}
                    name={`hours.${key}.open`}
                    type="time"
                    defaultValue={day.open}
                    className="w-32"
                  />
                  <span className="text-sm text-ink-400">to</span>
                  <label htmlFor={`hours-${key}-close`} className="sr-only">
                    {label} closing time
                  </label>
                  <Input
                    id={`hours-${key}-close`}
                    name={`hours.${key}.close`}
                    type="time"
                    defaultValue={day.close}
                    className="w-32"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <SubmitButton pendingLabel="Saving...">Save settings</SubmitButton>
    </form>
  );
}
