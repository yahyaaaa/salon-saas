"use client";

import { useActionState } from "react";

import { saveConsentTemplateAction, type CatalogueFormState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input } from "@/components/ui";
import { EditDisclosure } from "@/components/edit-disclosure";
import type { ConsentTemplateItemRow, ConsentTemplateRow } from "@/lib/types/database";

const textareaClasses =
  "block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 " +
  "placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25 focus:outline-none";

export function ConsentTemplateForm({
  template,
  items = [],
}: {
  template?: ConsentTemplateRow;
  items?: ConsentTemplateItemRow[];
}) {
  const [state, formAction] = useActionState<CatalogueFormState, FormData>(
    saveConsentTemplateAction,
    {},
  );
  const isEdit = Boolean(template);
  const uid = template?.id ?? "new";

  const body = (
    <form action={formAction} className="space-y-4">
      {template ? <input type="hidden" name="templateId" value={template.id} /> : null}

      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      {state.success ? <Alert tone="success">{state.success}</Alert> : null}

      <Field label="Template name" htmlFor={`tpl-name-${uid}`} error={state.errors?.name}>
        <Input
          id={`tpl-name-${uid}`}
          name="name"
          defaultValue={template?.name}
          required
          placeholder="Botox consent"
        />
      </Field>

      <Field
        label="Consent statements"
        htmlFor={`tpl-items-${uid}`}
        error={state.errors?.items ?? state.errors?.["items.0.label"]}
        hint="One per line. Each becomes a checkbox the customer must tick."
      >
        <textarea
          id={`tpl-items-${uid}`}
          name="items"
          rows={4}
          required
          defaultValue={items.map((item) => item.label).join("\n")}
          placeholder={"I consent to the injection risks as explained\nI confirm I am not pregnant or breastfeeding"}
          className={textareaClasses}
        />
      </Field>

      <Field label="Notes for the team" htmlFor={`tpl-desc-${uid}`} error={state.errors?.description}>
        <textarea
          id={`tpl-desc-${uid}`}
          name="description"
          rows={2}
          defaultValue={template?.description}
          className={textareaClasses}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input
          type="checkbox"
          name="requiresMedicalHistory"
          defaultChecked={template?.requires_medical_history ?? true}
          className="size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
        />
        Collect medical history and allergies with this form
      </label>

      <SubmitButton pendingLabel="Saving...">
        {isEdit ? "Save changes" : "Create template"}
      </SubmitButton>
    </form>
  );

  if (!isEdit) return body;
  return <EditDisclosure label="Edit">{body}</EditDisclosure>;
}
