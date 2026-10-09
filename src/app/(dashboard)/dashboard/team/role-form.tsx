"use client";

import { useActionState } from "react";

import { saveRoleAction, type TeamFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input } from "@/components/ui";
import { MODULES } from "@/lib/modules";
import type { AppModule, RoleRow } from "@/lib/types/database";

/**
 * What a role may reach.
 *
 * The ticks here are the same thing the database asks about: every policy
 * calls `has_module()`, so unticking a box removes the rows from under the
 * page rather than merely hiding a link.
 */
export function RoleForm({
  role,
  modules = [],
}: {
  role?: RoleRow;
  modules?: AppModule[];
}) {
  const [state, formAction] = useActionState<TeamFormState, FormData>(saveRoleAction, {});
  const id = role?.id ?? "new";
  const held = new Set(modules);

  return (
    <form action={formAction} className="space-y-4">
      {role ? <input type="hidden" name="roleId" value={role.id} /> : null}

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <Field
        label="Role name"
        htmlFor={`role-name-${id}`}
        error={state.errors?.name}
        className="max-w-sm"
        hint={role?.is_system ? "A built-in role keeps its name." : undefined}
      >
        <Input
          id={`role-name-${id}`}
          name="name"
          defaultValue={role?.name ?? ""}
          required
          readOnly={role?.is_system}
          placeholder="Accountant"
        />
      </Field>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-ink-700">Can reach</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {MODULES.map((m) => (
            <label
              key={m.module}
              className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-white px-3 py-2"
            >
              <input
                type="checkbox"
                name="modules"
                value={m.module}
                defaultChecked={held.has(m.module)}
                className="mt-0.5 size-4 shrink-0 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-800">{m.label}</span>
                <span className="block text-xs text-ink-500">{m.detail}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-500">
          Everyone sees the overview, their own account, and their own earnings, whatever
          is ticked here.
        </p>
      </fieldset>

      <SubmitButton variant={role ? "secondary" : "primary"} pendingLabel="Saving...">
        {role ? "Save permissions" : "Create role"}
      </SubmitButton>
    </form>
  );
}
