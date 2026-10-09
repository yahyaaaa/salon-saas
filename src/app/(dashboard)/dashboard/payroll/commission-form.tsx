"use client";

import { useActionState, useState } from "react";

import { saveCommissionAction, type PayrollFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input, Select } from "@/components/ui";
import type { CommissionBasis, StaffCompensationRow } from "@/lib/types/database";

/** "" is the unset basis: fall back to whatever each service says. */
type BasisChoice = "" | CommissionBasis;

const BASIS_HINT: Record<BasisChoice, string> = {
  "": "Each service's own rate applies. Services with no rate earn nothing.",
  none: "No commission at all, whatever the services say.",
  percentage: "A share of what they sell, overriding every service's own rate.",
  fixed_per_service: "A flat amount per service performed, overriding every service's own rate.",
};

/**
 * What one person is paid.
 *
 * Salary and commission are two INDEPENDENT settings, not one choice between
 * them. That is what makes the three arrangements expressible:
 *
 *   salary only      a salary, commission set to "None"
 *   commission only  salary left at 0
 *   both             a salary and a commission basis
 *
 * The old form offered them as mutually exclusive options in a single
 * dropdown, so a base salary with commission on top could not be entered at
 * all -- and a salary typed against a percentage basis was silently discarded.
 */
export function CommissionForm({
  staffId,
  name,
  compensation,
  currency,
}: {
  staffId: string;
  name: string;
  compensation?: StaffCompensationRow;
  currency: string;
}) {
  const [state, formAction] = useActionState<PayrollFormState, FormData>(
    saveCommissionAction,
    {},
  );

  const [basis, setBasis] = useState<BasisChoice>(compensation?.commission_basis ?? "");
  const [salary, setSalary] = useState(
    compensation && Number(compensation.salary_amount) > 0
      ? String(compensation.salary_amount)
      : "",
  );

  // An unset amount stores 0, and 0 is the one value the per-service basis
  // rejects. Defaulting these boxes to "0" produced a save that always failed
  // and a setting that appeared to revert.
  const fixedDefault =
    compensation && Number(compensation.fixed_amount ?? 0) > 0
      ? String(compensation.fixed_amount)
      : "";

  const blocking = state.errors?.fixedAmount ?? state.errors?.salaryAmount;
  const salaryValue = Math.max(0, Number(salary) || 0);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="staffId" value={staffId} />

      {blocking ? (
        <Alert tone="error">
          {blocking} &mdash; nothing was saved for {name}.
        </Alert>
      ) : null}

      <p className="text-sm font-medium text-ink-900">{name}</p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* ---- salary, on its own ---- */}
        <Field
          label={`Monthly salary (${currency})`}
          htmlFor={`salary-${staffId}`}
          error={state.errors?.salaryAmount}
          hint="Leave blank for none."
        >
          <Input
            id={`salary-${staffId}`}
            name="salaryAmount"
            type="number"
            step="0.01"
            min="0"
            value={salary}
            onChange={(event) => setSalary(event.target.value)}
            placeholder="0.00"
          />
        </Field>

        {/* ---- commission, independently ---- */}
        <Field
          label="Commission"
          htmlFor={`basis-${staffId}`}
          error={state.errors?.commissionBasis}
        >
          <Select
            id={`basis-${staffId}`}
            name="commissionBasis"
            value={basis}
            onChange={(event) => setBasis(event.target.value as BasisChoice)}
          >
            <option value="">Use each service&rsquo;s own rate</option>
            <option value="none">None</option>
            <option value="percentage">% of service value</option>
            <option value="fixed_per_service">Fixed per service</option>
          </Select>
        </Field>

        {basis === "percentage" ? (
          <Field label="Rate" htmlFor={`pct-${staffId}`} error={state.errors?.commissionPercent}>
            <div className="flex items-center gap-1.5">
              <Input
                id={`pct-${staffId}`}
                name="commissionPercent"
                type="number"
                step="0.01"
                min="0"
                max="100"
                defaultValue={((compensation?.commission_rate ?? 0) * 100).toFixed(2)}
              />
              <span className="pb-2 text-sm text-ink-500">%</span>
            </div>
          </Field>
        ) : basis === "fixed_per_service" ? (
          <Field
            label={`Per service (${currency})`}
            htmlFor={`fixed-${staffId}`}
            error={state.errors?.fixedAmount}
          >
            <Input
              id={`fixed-${staffId}`}
              name="fixedAmount"
              type="number"
              step="0.01"
              min="0"
              defaultValue={fixedDefault}
              placeholder="0.00"
              required
            />
          </Field>
        ) : (
          <div className="hidden lg:block" />
        )}

        <Field label="Joined" htmlFor={`joined-${staffId}`} error={state.errors?.joiningDate}>
          <Input
            id={`joined-${staffId}`}
            name="joiningDate"
            type="date"
            defaultValue={compensation?.joining_date ?? ""}
          />
        </Field>
      </div>

      {/*
        The bases not in use are still submitted, so neither column is left
        null by accident -- PostgREST sends an explicit NULL for any column
        omitted from an upsert.
      */}
      {basis !== "percentage" ? (
        <input type="hidden" name="commissionPercent" value="0" />
      ) : null}
      {basis !== "fixed_per_service" ? (
        <input type="hidden" name="fixedAmount" value="0" />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-500">
          <span className="font-medium text-ink-700">{arrangement(salaryValue, basis)}.</span>{" "}
          {BASIS_HINT[basis]}
        </p>
        <SubmitButton variant="secondary" size="sm" pendingLabel="Saving...">
          Save
        </SubmitButton>
      </div>

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}
    </form>
  );
}

/** Names the arrangement back to the owner, so the combination is legible. */
function arrangement(salary: number, basis: BasisChoice): string {
  const paidSalary = salary > 0;
  const paidCommission = basis !== "none";

  if (paidSalary && paidCommission) return "Salary plus commission";
  if (paidSalary) return "Salary only";
  if (paidCommission) return "Commission only";
  return "Unpaid by this system";
}
