"use client";

import { useMemo, useState } from "react";

import { Combobox } from "@/components/combobox";
import { Field, Input } from "@/components/ui";
import { COUNTRIES, allTimeZones, findCountry } from "@/lib/countries";

/**
 * Country, currency and timezone as one linked control.
 *
 * Choosing a country fills in the other two. The currency is shown rather than
 * typed -- there is one right answer per country and guessing at a code is a
 * good way to get a salon's money formatted wrong. The timezone is a
 * suggestion, not a rule: plenty of countries span several, so it stays a full
 * searchable list with the country's principal zone preselected.
 */
export function LocaleFields({
  defaultCountry = "",
  defaultCurrency = "",
  defaultTimezone = "",
  errors = {},
  idPrefix = "locale",
}: {
  defaultCountry?: string;
  defaultCurrency?: string;
  defaultTimezone?: string;
  errors?: Record<string, string | undefined>;
  idPrefix?: string;
}) {
  const initial = findCountry(defaultCountry);

  const [country, setCountry] = useState(initial?.name ?? defaultCountry);
  const [currency, setCurrency] = useState(
    defaultCurrency || initial?.currency || "",
  );
  const [timezone, setTimezone] = useState(defaultTimezone || initial?.zone || "");

  const countryOptions = useMemo(
    () => COUNTRIES.map((c) => ({ value: c.name, label: c.name, hint: c.currency })),
    [],
  );

  const zoneOptions = useMemo(
    () => allTimeZones().map((z) => ({ value: z, label: z.replace(/_/g, " ") })),
    [],
  );

  const suggested = findCountry(country)?.zone;

  function onCountry(nextName: string) {
    setCountry(nextName);
    const match = findCountry(nextName);
    if (!match) return;
    setCurrency(match.currency);
    setTimezone(match.zone);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Field label="Country" htmlFor={`${idPrefix}-country`} error={errors.country}>
        <Combobox
          id={`${idPrefix}-country`}
          name="country"
          options={countryOptions}
          defaultValue={country}
          placeholder="Start typing..."
          required
          invalid={Boolean(errors.country)}
          onSelect={onCountry}
        />
      </Field>

      <Field
        label="Currency"
        htmlFor={`${idPrefix}-currency`}
        error={errors.currency}
        hint="Set by the country."
      >
        <Input
          id={`${idPrefix}-currency`}
          name="currency"
          value={currency}
          onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          maxLength={3}
          required
          readOnly
          className="bg-ink-50"
        />
      </Field>

      <Field
        label="Timezone"
        htmlFor={`${idPrefix}-timezone`}
        error={errors.timezone}
        hint={
          suggested && timezone !== suggested
            ? `Suggested: ${suggested.replace(/_/g, " ")}`
            : "Change it if your salon keeps a different clock."
        }
      >
        {/* Keyed on the country so choosing one re-seeds the box. */}
        <Combobox
          key={`${idPrefix}-${timezone}`}
          id={`${idPrefix}-timezone`}
          name="timezone"
          options={zoneOptions}
          defaultValue={timezone}
          placeholder="Search timezones..."
          required
          invalid={Boolean(errors.timezone)}
          onSelect={setTimezone}
        />
      </Field>
    </div>
  );
}
