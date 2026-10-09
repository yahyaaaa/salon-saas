"use client";

import { useActionState } from "react";

import { saveDealAction, type CatalogueFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input, Select } from "@/components/ui";
import { EditDisclosure } from "@/components/edit-disclosure";
import type { DealRow, ServiceRow } from "@/lib/types/database";

export function DealForm({
  services,
  currency,
  deal,
  linkedServiceIds = [],
}: {
  services: ServiceRow[];
  currency: string;
  deal?: DealRow;
  linkedServiceIds?: string[];
}) {
  const [state, formAction] = useActionState<CatalogueFormState, FormData>(saveDealAction, {});
  const isEdit = Boolean(deal);
  const uid = deal?.id ?? "new";

  const body = (
    <form action={formAction} className="space-y-4">
      {deal ? <input type="hidden" name="dealId" value={deal.id} /> : null}

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Deal name" htmlFor={`deal-name-${uid}`} error={state.errors?.name}>
          <Input
            id={`deal-name-${uid}`}
            name="name"
            defaultValue={deal?.name}
            required
            placeholder="20% off facials this month"
          />
        </Field>

        <Field label="Type" htmlFor={`deal-type-${uid}`} error={state.errors?.dealType}>
          <Select id={`deal-type-${uid}`} name="dealType" defaultValue={deal?.deal_type ?? "percentage"}>
            <option value="percentage">Percentage off</option>
            <option value="fixed_amount">Fixed amount off</option>
            <option value="bundle_price">Bundle price for the set</option>
          </Select>
        </Field>

        <Field
          label={`Value (% or ${currency})`}
          htmlFor={`deal-value-${uid}`}
          error={state.errors?.value}
        >
          <Input
            id={`deal-value-${uid}`}
            name="value"
            type="number"
            step="0.01"
            min="0"
            defaultValue={deal?.value}
            required
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" htmlFor={`deal-start-${uid}`} error={state.errors?.startsOn}>
            <Input
              id={`deal-start-${uid}`}
              name="startsOn"
              type="date"
              defaultValue={deal?.starts_on}
              required
            />
          </Field>
          <Field label="Ends" htmlFor={`deal-end-${uid}`} error={state.errors?.endsOn}>
            <Input
              id={`deal-end-${uid}`}
              name="endsOn"
              type="date"
              defaultValue={deal?.ends_on}
              required
            />
          </Field>
        </div>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink-700">Applies to</legend>
        {state.errors?.serviceIds ? (
          <p className="mb-2 text-xs font-medium text-red-600">{state.errors.serviceIds}</p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          {services.length === 0 ? (
            <p className="text-xs text-ink-500">Add a service first.</p>
          ) : (
            services.map((service) => (
              <label key={service.id} className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  name="serviceIds"
                  value={service.id}
                  defaultChecked={linkedServiceIds.includes(service.id)}
                  className="size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                />
                {service.name}
              </label>
            ))
          )}
        </div>
      </fieldset>

      <SubmitButton pendingLabel="Saving...">{isEdit ? "Save changes" : "Create deal"}</SubmitButton>
    </form>
  );

  if (!isEdit) return body;
  return <EditDisclosure label="Edit">{body}</EditDisclosure>;
}
