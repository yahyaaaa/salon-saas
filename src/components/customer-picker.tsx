"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { searchCustomersAction, type CustomerMatch } from "@/app/(dashboard)/dashboard/customers/actions";
import { Alert, Button, Field, Input, cn } from "@/components/ui";

/**
 * Choosing who a booking or a sale is for.
 *
 * Search-as-you-type rather than a list of everyone: a salon with two thousand
 * customers cannot be scrolled, and the person at the desk already knows who
 * they are looking for. Only the top few matches are shown, because more than
 * that means the query was not specific enough, not that the list should be
 * longer.
 *
 * "New customer" is a mode here, not an option in the results. The record is
 * NOT created as you type -- the name and phone travel with the booking and
 * are written by the same transaction, so a booking that fails leaves no
 * half-made profile behind.
 */
export function CustomerPicker({
  idPrefix,
  errors = {},
  defaultMode = "existing",
  defaultCustomerId = "",
  defaultCustomerLabel = "",
  defaultName = "",
  defaultPhone = "",
  onCustomerChange,
}: {
  idPrefix: string;
  errors?: Record<string, string | undefined>;
  defaultMode?: "existing" | "new";
  defaultCustomerId?: string;
  defaultCustomerLabel?: string;
  defaultName?: string;
  defaultPhone?: string;
  onCustomerChange?: (customerId: string) => void;
}) {
  const [mode, setMode] = useState<"existing" | "new">(defaultMode);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<CustomerMatch[]>([]);
  const [chosen, setChosen] = useState<{ id: string; label: string } | null>(
    defaultCustomerId ? { id: defaultCustomerId, label: defaultCustomerLabel || "Selected customer" } : null,
  );
  const [searching, startSearch] = useTransition();
  const latest = useRef(0);

  // Debounced, and stale replies are discarded -- otherwise a slow response to
  // "ali" can land after a fast one to "alina" and overwrite it.
  //
  // Clearing on a too-short query happens in the change handler rather than
  // here, so this effect only ever reacts to a search completing.
  useEffect(() => {
    const trimmed = query.trim();
    if (mode !== "existing" || trimmed.length < 2) return;

    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      startSearch(async () => {
        const found = await searchCustomersAction(trimmed, 3);
        if (ticket === latest.current) setMatches(found);
      });
    }, 180);

    return () => clearTimeout(timer);
  }, [query, mode]);

  function onQueryChange(next: string) {
    setQuery(next);
    // Drop the previous matches immediately rather than showing them against a
    // query they no longer answer.
    if (next.trim().length < 2) setMatches([]);
  }

  function choose(match: CustomerMatch) {
    setChosen({ id: match.id, label: `${match.full_name} — ${match.phone}` });
    setQuery("");
    setMatches([]);
    onCustomerChange?.(match.id);
  }

  function clearChoice() {
    setChosen(null);
    onCustomerChange?.("");
  }

  function switchMode(next: "existing" | "new") {
    setMode(next);
    setQuery("");
    setMatches([]);
    if (next === "new") clearChoice();
  }

  return (
    <div className="space-y-3">
      <input type="hidden" name="customerMode" value={mode} />
      {mode === "existing" ? (
        <input type="hidden" name="customerId" value={chosen?.id ?? ""} />
      ) : null}

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink-700">Customer</legend>
        <div className="flex flex-wrap gap-4">
          {(
            [
              ["existing", "Existing customer"],
              ["new", "New customer"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="radio"
                checked={mode === value}
                onChange={() => switchMode(value)}
                className="size-4 border-ink-300 text-brand-600 focus:ring-brand-500"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {mode === "existing" ? (
        chosen ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2">
            <span className="text-sm font-medium text-brand-700">{chosen.label}</span>
            <Button type="button" variant="ghost" size="sm" onClick={clearChoice}>
              Change
            </Button>
          </div>
        ) : (
          <div>
            <label
              htmlFor={`${idPrefix}-search`}
              className="mb-1.5 block text-sm font-medium text-ink-700"
            >
              Search by name or phone
            </label>
            <Input
              id={`${idPrefix}-search`}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Start typing a name or number..."
              autoComplete="off"
            />

            {errors.customerId ? (
              <p className="mt-1 text-xs font-medium text-red-600">{errors.customerId}</p>
            ) : null}

            {query.trim().length >= 2 ? (
              <ul className="mt-2 divide-y divide-ink-100 rounded-lg border border-ink-200">
                {matches.length === 0 ? (
                  <li className="px-3 py-2 text-sm text-ink-500">
                    {searching ? "Searching..." : "Nobody matches that. Try fewer characters, or add them as a new customer."}
                  </li>
                ) : (
                  matches.map((match) => (
                    <li key={match.id}>
                      <button
                        type="button"
                        onClick={() => choose(match)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm",
                          "text-ink-700 hover:bg-brand-50 hover:text-brand-700",
                        )}
                      >
                        <span className="truncate font-medium">{match.full_name}</span>
                        <span className="shrink-0 text-xs text-ink-500">{match.phone}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-ink-500">Type at least two characters.</p>
            )}
          </div>
        )
      ) : (
        <div className="grid gap-4 rounded-lg border border-ink-200 bg-ink-50 p-4 sm:grid-cols-2">
          <Field label="Name" htmlFor={`${idPrefix}-new-name`} error={errors.newCustomerName}>
            <Input
              id={`${idPrefix}-new-name`}
              name="newCustomerName"
              defaultValue={defaultName}
              required
            />
          </Field>
          <Field
            label="Phone"
            htmlFor={`${idPrefix}-new-phone`}
            error={errors.newCustomerPhone}
            hint="The profile is created only if this booking succeeds."
          >
            <Input
              id={`${idPrefix}-new-phone`}
              name="newCustomerPhone"
              type="tel"
              defaultValue={defaultPhone}
              required
            />
          </Field>
          {errors.customerConflict ? (
            <div className="sm:col-span-2">
              <Alert tone="warning">{errors.customerConflict}</Alert>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
