"use client";

import { useActionState, useState } from "react";

import { saveServiceAction, type CatalogueFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input, Select } from "@/components/ui";
import { EditDisclosure } from "@/components/edit-disclosure";
import { formatMoney } from "@/lib/format";
import type {
  CommissionBasis,
  ConsentTemplateRow,
  ServiceRow,
  TeamMemberRow,
} from "@/lib/types/database";

export function ServiceForm({
  therapists,
  templates,
  currency,
  service,
  assignedStaffIds = [],
}: {
  therapists: TeamMemberRow[];
  templates: ConsentTemplateRow[];
  currency: string;
  service?: ServiceRow;
  assignedStaffIds?: string[];
}) {
  const [state, formAction] = useActionState<CatalogueFormState, FormData>(
    saveServiceAction,
    {},
  );
  const isEdit = Boolean(service);

  const body = (
    <form action={formAction} className="space-y-4">
      {service ? <input type="hidden" name="serviceId" value={service.id} /> : null}

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Service name" htmlFor={`name-${service?.id ?? "new"}`} error={state.errors?.name}>
          <Input
            id={`name-${service?.id ?? "new"}`}
            name="name"
            defaultValue={service?.name}
            required
            placeholder="Gel manicure"
          />
        </Field>

        <Field label="Category" htmlFor={`category-${service?.id ?? "new"}`} error={state.errors?.category}>
          <Input
            id={`category-${service?.id ?? "new"}`}
            name="category"
            defaultValue={service?.category ?? "General"}
            placeholder="Nails"
          />
        </Field>

        <Field
          label={`Price (${currency})`}
          htmlFor={`price-${service?.id ?? "new"}`}
          error={state.errors?.price}
        >
          <Input
            id={`price-${service?.id ?? "new"}`}
            name="price"
            type="number"
            step="0.01"
            min="0"
            defaultValue={service?.price}
            required
          />
        </Field>

        <Field
          label="Duration"
          htmlFor={`duration-${service?.id ?? "new"}`}
          error={state.errors?.durationMinutes}
          hint="Minutes. This is how long the therapist's calendar is blocked."
        >
          <Input
            id={`duration-${service?.id ?? "new"}`}
            name="durationMinutes"
            type="number"
            step="5"
            min="5"
            defaultValue={service?.duration_minutes ?? 30}
            required
          />
        </Field>
      </div>

      <Field
        label="Description"
        htmlFor={`description-${service?.id ?? "new"}`}
        error={state.errors?.description}
      >
        <textarea
          id={`description-${service?.id ?? "new"}`}
          name="description"
          rows={2}
          defaultValue={service?.description}
          className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25 focus:outline-none"
        />
      </Field>

      <Field
        label="Consent template"
        htmlFor={`consent-${service?.id ?? "new"}`}
        error={state.errors?.consentTemplateId}
        hint="Required before this treatment can be performed, if set."
      >
        <Select
          id={`consent-${service?.id ?? "new"}`}
          name="consentTemplateId"
          defaultValue={service?.consent_template_id ?? ""}
        >
          <option value="">No consent form needed</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>
      </Field>

      <ServiceCommission service={service} currency={currency} errors={state.errors ?? {}} />

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink-700">
          Who can perform this
        </legend>
        <p className="mb-2 text-xs text-ink-500">
          Leave all unticked to allow any therapist. Receptionists are not listed —
          they do not perform treatments.
        </p>
        <div className="flex flex-wrap gap-3">
          {therapists.length === 0 ? (
            <p className="text-xs text-ink-500">No therapists on the team yet.</p>
          ) : (
            therapists.map((person) => (
              <label key={person.id} className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  name="staffIds"
                  value={person.id}
                  defaultChecked={assignedStaffIds.includes(person.id)}
                  className="size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                />
                {person.full_name}
              </label>
            ))
          )}
        </div>
      </fieldset>

      <SubmitButton pendingLabel="Saving...">
        {isEdit ? "Save changes" : "Add service"}
      </SubmitButton>
    </form>
  );

  if (!isEdit) return body;

  return <EditDisclosure label="Edit">{body}</EditDisclosure>;
}

/**
 * What this service pays whoever performs it.
 *
 * A DEFAULT, not a rule: a staff member with a rate of their own overrides it
 * entirely. Setting it here means a salon can price commission by treatment --
 * a colour paying more than a blow-dry -- without configuring every therapist
 * individually.
 */
function ServiceCommission({
  service,
  currency,
  errors,
}: {
  service?: ServiceRow;
  currency: string;
  errors: Record<string, string | undefined>;
}) {
  const [basis, setBasis] = useState<"" | CommissionBasis>(service?.commission_basis ?? "");
  const id = service?.id ?? "new";

  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Commission for this service"
          htmlFor={`comm-basis-${id}`}
          error={errors.commissionBasis}
          hint="Overridden by anyone who has a rate of their own."
        >
          <Select
            id={`comm-basis-${id}`}
            name="commissionBasis"
            value={basis}
            onChange={(event) => setBasis(event.target.value as "" | CommissionBasis)}
          >
            <option value="">None</option>
            <option value="percentage">% of the price</option>
            <option value="fixed_per_service">Fixed amount</option>
          </Select>
        </Field>

        {basis === "percentage" ? (
          <Field
            label="Rate"
            htmlFor={`comm-pct-${id}`}
            error={errors.commissionPercent}
            hint={
              service
                ? `Currently ${formatMoney(
                    (Number(service.price) * Number(service.commission_rate ?? 0)),
                    currency,
                  )} per booking at the list price.`
                : undefined
            }
          >
            <div className="flex items-center gap-1.5">
              <Input
                id={`comm-pct-${id}`}
                name="commissionPercent"
                type="number"
                step="0.01"
                min="0"
                max="100"
                defaultValue={((service?.commission_rate ?? 0) * 100).toFixed(2)}
                required
              />
              <span className="pb-2 text-sm text-ink-500">%</span>
            </div>
          </Field>
        ) : basis === "fixed_per_service" ? (
          <Field
            label={`Amount (${currency})`}
            htmlFor={`comm-fixed-${id}`}
            error={errors.commissionFixed}
          >
            <Input
              id={`comm-fixed-${id}`}
              name="commissionFixed"
              type="number"
              step="0.01"
              min="0"
              defaultValue={
                Number(service?.commission_fixed ?? 0) > 0
                  ? String(service?.commission_fixed)
                  : ""
              }
              placeholder="0.00"
              required
            />
          </Field>
        ) : null}
      </div>

      {/* The unused rate is still submitted, so its column is cleared rather
          than keeping a stale figure from a previous basis. */}
      {basis !== "percentage" ? (
        <input type="hidden" name="commissionPercent" value="0" />
      ) : null}
      {basis !== "fixed_per_service" ? (
        <input type="hidden" name="commissionFixed" value="0" />
      ) : null}
    </div>
  );
}
