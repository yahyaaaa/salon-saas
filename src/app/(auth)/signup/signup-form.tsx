"use client";

import { useActionState } from "react";

import { signUpAction, type FormState } from "../actions";
import { SubmitButton } from "@/components/submit-button";
import { LocaleFields } from "@/components/locale-fields";
import { Alert, Field, Input, Select } from "@/components/ui";

export function SignupForm() {
  const [state, formAction] = useActionState<FormState, FormData>(signUpAction, {});

  // React clears an uncontrolled form once its action resolves, so a rejected
  // submission is re-seeded from what was typed rather than coming back blank.
  const was = (name: string) => state.values?.[name] ?? "";

  if (state.pendingConfirmation) {
    return (
      <Alert tone="success">
        <p className="font-medium">Check your email</p>
        <p className="mt-1">
          We sent a confirmation link to <strong>{state.pendingConfirmation}</strong>. Your
          salon is ready as soon as you confirm.
        </p>
      </Alert>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field label="Salon name" htmlFor="salonName" error={state.errors?.salonName}>
        <Input
          id="salonName"
          name="salonName"
          defaultValue={was("salonName")}
          required
          placeholder="Lumière Studio"
        />
      </Field>

      <Field label="Business type" htmlFor="businessType" error={state.errors?.businessType}>
        <Select
          id="businessType"
          name="businessType"
          defaultValue={was("businessType") || "salon"}
        >
          <option value="salon">Salon</option>
          <option value="aesthetic_clinic">Aesthetic clinic</option>
        </Select>
      </Field>

      <Field label="Your name" htmlFor="fullName" error={state.errors?.fullName}>
        <Input
          id="fullName"
          name="fullName"
          autoComplete="name"
          defaultValue={was("fullName")}
          required
        />
      </Field>

      <Field label="Email" htmlFor="email" error={state.errors?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={was("email")}
          required
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        error={state.errors?.password}
        hint="At least 8 characters."
      >
        {/* Never echoed back, for the obvious reason. */}
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
      </Field>

      <LocaleFields
        idPrefix="signup"
        defaultCountry={was("country")}
        defaultCurrency={was("currency")}
        defaultTimezone={was("timezone")}
        errors={state.errors ?? {}}
      />

      <SubmitButton className="w-full" pendingLabel="Creating your salon...">
        Start 14-day free trial
      </SubmitButton>
    </form>
  );
}
