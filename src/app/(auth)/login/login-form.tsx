"use client";

import { useActionState } from "react";

import { signInAction, type FormState } from "../actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input } from "@/components/ui";

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(signInAction, {});

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}

      <Field label="Email" htmlFor="email" error={state.errors?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@salon.com"
        />
      </Field>

      <Field label="Password" htmlFor="password" error={state.errors?.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>

      <SubmitButton className="w-full" pendingLabel="Signing in...">
        Sign in
      </SubmitButton>
    </form>
  );
}
