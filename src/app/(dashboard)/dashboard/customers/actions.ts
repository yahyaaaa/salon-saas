"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AUDIT_ACTIONS, logAudit } from "@/lib/audit";
import { assertModule, requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MAX_FILES,
  consentFormSchema,
  customerSchema,
  describeAttachmentProblem,
  fieldErrors,
} from "@/lib/validation";

export interface CustomerFormState {
  message?: string;
  success?: string;
  errors?: Record<string, string>;
}

function nullableUuid(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s === "" ? null : s;
}

/* -------------------------------------------------------------------------- */
/* Customer profiles                                                           */
/* -------------------------------------------------------------------------- */

export async function saveCustomerAction(
  _prevState: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const session = await requireSession();
  try {
    // The brief puts customer profiles on the front desk.
    assertModule(session, "customers");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = customerSchema.safeParse({
    fullName: formData.get("fullName"),
    phone: formData.get("phone"),
    email: formData.get("email") ?? "",
    dateOfBirth: formData.get("dateOfBirth") ?? "",
    notes: formData.get("notes") ?? "",
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const input = parsed.data;
  const customerId = nullableUuid(formData.get("customerId"));
  const supabase = await createClient();

  const row = {
    salon_id: session.profile.salon_id,
    full_name: input.fullName,
    phone: input.phone,
    email: input.email || null,
    date_of_birth: input.dateOfBirth || null,
    notes: input.notes,
  };

  const { data: saved, error } = customerId
    ? await supabase.from("customers").update(row).eq("id", customerId).select("id").maybeSingle()
    : await supabase
        .from("customers")
        .insert({ ...row, created_by: session.userId })
        .select("id")
        .single();

  if (error) {
    // The unique index is on (salon_id, phone_normalized), so this only ever
    // means a duplicate within this salon. Naming who already holds the number
    // turns a dead end into a next step.
    if (error.code === "23505") {
      const digits = input.phone.replace(/[^0-9]/g, "");
      const { data: clash } = await supabase
        .from("customers")
        .select("id, full_name")
        .eq("phone_normalized", digits)
        .maybeSingle();

      return {
        errors: {
          phone: clash
            ? `${clash.full_name} already uses that number. Open their profile instead of creating a second one.`
            : "Another customer in this salon already uses that number.",
        },
      };
    }
    return { message: error.message };
  }
  if (!saved) return { message: "That customer no longer exists." };

  await logAudit(session, {
    action: customerId ? AUDIT_ACTIONS.CUSTOMER_UPDATED : AUDIT_ACTIONS.CUSTOMER_CREATED,
    entityType: "customer",
    entityId: saved.id,
    // Deliberately no notes and no date of birth in the audit metadata.
    metadata: { name: input.fullName },
  });

  revalidatePath("/dashboard/customers");
  revalidatePath(`/dashboard/customers/${saved.id}`);

  if (!customerId) redirect(`/dashboard/customers/${saved.id}`);
  return { success: "Customer saved." };
}

/* -------------------------------------------------------------------------- */
/* Consent / medical intake                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Record a consent form.
 *
 * Ordering matters, and it is chosen so a failure never leaves a record that
 * claims to be signed when it is not:
 *
 *   1. insert the form with signed_at NULL  -- a draft
 *   2. insert the snapshotted responses
 *   3. upload any attachments
 *   4. upload the signature image
 *   5. set signature_path and signed_at    -- the form becomes immutable here
 *
 * Attachments go on before the signature on purpose: signing is what freezes
 * the record, and a signature should cover everything the record contains.
 * Nothing can be attached afterwards -- see the Phase 6 attachments migration
 * for why.
 *
 * If any step fails the draft is discarded (the only DELETE policy on
 * consent_forms covers exactly this case: your own, still unsigned).
 */
export async function createConsentFormAction(
  _prevState: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const session = await requireSession();

  let responses: unknown = [];
  try {
    responses = JSON.parse(String(formData.get("responses") ?? "[]"));
  } catch {
    return { message: "The consent statements could not be read. Please try again." };
  }

  const parsed = consentFormSchema.safeParse({
    customerId: formData.get("customerId"),
    templateId: nullableUuid(formData.get("templateId")),
    serviceId: nullableUuid(formData.get("serviceId")),
    appointmentId: nullableUuid(formData.get("appointmentId")),
    medicalHistory: formData.get("medicalHistory") ?? "",
    allergies: formData.get("allergies") ?? "",
    signature: formData.get("signature"),
    responses,
  });

  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    // Surface the signature problem on the pad rather than on a hidden input.
    if (errors.signature) errors.signature = "Please capture a signature before saving.";
    return { errors };
  }

  const input = parsed.data;

  // Every required statement must actually be ticked. Checked server-side:
  // the client cannot be trusted to have enforced it.
  const unticked = input.responses.filter((r) => r.isRequired && !r.checked);
  if (unticked.length > 0) {
    return {
      message: `Every required statement must be agreed to. Outstanding: "${unticked[0].label}"`,
    };
  }

  const supabase = await createClient();
  const salonId = session.profile.salon_id;

  // Confirm the customer is ours before building a storage path from their id.
  const { data: customer } = await supabase
    .from("customers")
    .select("id")
    .eq("id", input.customerId)
    .maybeSingle();
  if (!customer) return { message: "That customer could not be found." };

  const { data: draft, error: draftError } = await supabase
    .from("consent_forms")
    .insert({
      salon_id: salonId,
      customer_id: input.customerId,
      template_id: input.templateId || null,
      service_id: input.serviceId || null,
      appointment_id: input.appointmentId || null,
      collected_by: session.userId,
      medical_history: input.medicalHistory,
      allergies: input.allergies,
    })
    .select("id")
    .single();

  if (draftError) return { message: draftError.message };

  async function discardDraft(formId: string) {
    await supabase.from("consent_forms").delete().eq("id", formId);
  }

  if (input.responses.length > 0) {
    const { error: responsesError } = await supabase.from("consent_form_responses").insert(
      input.responses.map((response, index) => ({
        salon_id: salonId,
        form_id: draft.id,
        item_id: response.itemId ?? null,
        // A copy, not a reference: editing the template later must not change
        // what this customer agreed to.
        label: response.label,
        is_required: response.isRequired,
        checked: response.checked,
        sort_order: index,
      })),
    );
    if (responsesError) {
      await discardDraft(draft.id);
      return { message: responsesError.message };
    }
  }

  // --- attachments ----------------------------------------------------------
  const files = formData
    .getAll("attachments")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (files.length > ATTACHMENT_MAX_FILES) {
    await discardDraft(draft.id);
    return { errors: { attachments: `Attach at most ${ATTACHMENT_MAX_FILES} files.` } };
  }

  const uploadedPaths: string[] = [];

  async function discardAttachments() {
    if (uploadedPaths.length > 0) {
      await supabase.storage.from("consent-attachments").remove(uploadedPaths);
    }
  }

  for (const file of files) {
    const problem = describeAttachmentProblem(file);
    if (problem) {
      await discardAttachments();
      await discardDraft(draft.id);
      return { errors: { attachments: problem } };
    }

    const attachmentId = randomUUID();
    const extension = ATTACHMENT_EXTENSIONS[file.type] ?? "bin";
    const path = `${salonId}/${input.customerId}/${draft.id}/${attachmentId}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("consent-attachments")
      .upload(path, file, { contentType: file.type, upsert: false });

    if (uploadError) {
      await discardAttachments();
      await discardDraft(draft.id);
      return { message: `${file.name} could not be stored: ${uploadError.message}` };
    }
    uploadedPaths.push(path);

    const { error: rowError } = await supabase.from("consent_form_attachments").insert({
      id: attachmentId,
      salon_id: salonId,
      form_id: draft.id,
      customer_id: input.customerId,
      file_path: path,
      file_name: file.name.slice(0, 300),
      mime_type: file.type,
      size_bytes: file.size,
      uploaded_by: session.userId,
    });

    if (rowError) {
      await discardAttachments();
      await discardDraft(draft.id);
      return { message: `${file.name} could not be recorded: ${rowError.message}` };
    }
  }

  const signaturePath = `${salonId}/${input.customerId}/${draft.id}.png`;
  const base64 = input.signature.slice(input.signature.indexOf(",") + 1);
  const bytes = Buffer.from(base64, "base64");

  const { error: uploadError } = await supabase.storage
    .from("consent-signatures")
    .upload(signaturePath, bytes, { contentType: "image/png", upsert: false });

  if (uploadError) {
    await discardAttachments();
    await discardDraft(draft.id);
    return { message: `The signature could not be stored: ${uploadError.message}` };
  }

  // `.select()` matters: a zero-row UPDATE is not an error in PostgREST, so
  // without checking what came back a missing policy would look like success
  // and leave the form permanently unsigned.
  const { data: sealed, error: signError } = await supabase
    .from("consent_forms")
    .update({ signature_path: signaturePath, signed_at: new Date().toISOString() })
    .eq("id", draft.id)
    .select("id, signed_at")
    .maybeSingle();

  if (!signError && !sealed?.signed_at) {
    await supabase.storage.from("consent-signatures").remove([signaturePath]);
    await discardAttachments();
    await discardDraft(draft.id);
    return {
      message:
        "The consent form could not be signed. Nothing has been recorded — please try again.",
    };
  }

  if (signError) {
    await supabase.storage.from("consent-signatures").remove([signaturePath]);
    await discardAttachments();
    await discardDraft(draft.id);
    return { message: signError.message };
  }

  await logAudit(session, {
    action: AUDIT_ACTIONS.CONSENT_FORM_CREATED,
    entityType: "consent_form",
    entityId: draft.id,
    // Never the medical history, the allergies, or the statements themselves.
    metadata: {
      customer_id: input.customerId,
      service_id: input.serviceId ?? null,
      appointment_id: input.appointmentId ?? null,
      statements: input.responses.length,
      // A count only -- never the file names, which can themselves be
      // revealing ("hiv-result.pdf").
      attachments: uploadedPaths.length,
    },
  });

  revalidatePath(`/dashboard/customers/${input.customerId}`);
  return { success: "Consent form recorded." };
}

/**
 * A short-lived URL for one signature image.
 *
 * The signed URL is minted through the RLS-bound client, so Storage applies the
 * same rule as the consent form itself -- a therapist who did not collect the
 * form gets nothing back, even holding the exact object path.
 */
export async function getSignatureUrlAction(formId: string): Promise<string | null> {
  const session = await requireSession();
  const supabase = await createClient();

  const { data: form } = await supabase
    .from("consent_forms")
    .select("id, customer_id, signature_path")
    .eq("id", formId)
    .maybeSingle();

  if (!form?.signature_path) return null;

  const { data, error } = await supabase.storage
    .from("consent-signatures")
    .createSignedUrl(form.signature_path, 60);

  if (error || !data) return null;

  await logAudit(session, {
    action: AUDIT_ACTIONS.CONSENT_FORM_VIEWED,
    entityType: "consent_form",
    entityId: form.id,
    metadata: { customer_id: form.customer_id },
  });

  return data.signedUrl;
}

/**
 * A short-lived URL for one attachment.
 *
 * Minted through the RLS-bound Storage client, so the same rule that governs
 * the consent form governs its documents: a therapist who did not collect the
 * form and is not treating its appointment gets nothing back, even holding the
 * exact object path. Each fetch is recorded, as signature views are.
 */
export async function getAttachmentUrlAction(attachmentId: string): Promise<string | null> {
  const session = await requireSession();
  const supabase = await createClient();

  const { data: attachment } = await supabase
    .from("consent_form_attachments")
    .select("id, form_id, customer_id, file_path")
    .eq("id", attachmentId)
    .maybeSingle();

  if (!attachment) return null;

  const { data, error } = await supabase.storage
    .from("consent-attachments")
    .createSignedUrl(attachment.file_path, 60);

  if (error || !data) return null;

  await logAudit(session, {
    action: AUDIT_ACTIONS.CONSENT_FORM_VIEWED,
    entityType: "consent_form",
    entityId: attachment.form_id,
    metadata: { customer_id: attachment.customer_id, attachment: true },
  });

  return data.signedUrl;
}

export interface CustomerMatch {
  id: string;
  full_name: string;
  phone: string;
}

/**
 * Type-ahead customer lookup for the booking and till pickers.
 *
 * Deliberately returns a handful, not a page: the front desk is identifying one
 * person they already have in mind, so a short list they can scan beats a long
 * one they have to scroll. Matching on digits as well as name means the phone
 * number on the appointment card is enough to find someone.
 */
export async function searchCustomersAction(
  query: string,
  limit = 3,
): Promise<CustomerMatch[]> {
  const session = await requireSession();
  assertModule(session, "customers");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_customers", {
    p_query: query ?? "",
    p_limit: limit,
  });

  if (error) return [];
  return (data ?? []) as CustomerMatch[];
}
