"use server";

import { revalidatePath } from "next/cache";

import { AUDIT_ACTIONS, logAudit } from "@/lib/audit";
import { assertModule, requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  consentTemplateSchema,
  dealSchema,
  fieldErrors,
  serviceSchema,
} from "@/lib/validation";

export interface CatalogueFormState {
  message?: string;
  success?: string;
  errors?: Record<string, string>;
}

/** Empty select values arrive as "" from a form; the column wants NULL. */
function nullableUuid(value: FormDataEntryValue | null): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s === "" ? null : s;
}

/* -------------------------------------------------------------------------- */
/* Services                                                                    */
/* -------------------------------------------------------------------------- */

export async function saveServiceAction(
  _prevState: CatalogueFormState,
  formData: FormData,
): Promise<CatalogueFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "services");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = serviceSchema.safeParse({
    name: formData.get("name"),
    category: formData.get("category") || "General",
    description: formData.get("description") ?? "",
    price: formData.get("price"),
    durationMinutes: formData.get("durationMinutes"),
    consentTemplateId: nullableUuid(formData.get("consentTemplateId")),
    staffIds: formData.getAll("staffIds").map(String),
    commissionBasis: formData.get("commissionBasis") ?? "",
    commissionPercent: formData.get("commissionPercent") || 0,
    commissionFixed: formData.get("commissionFixed") || 0,
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const input = parsed.data;
  const serviceId = nullableUuid(formData.get("serviceId"));
  const salonId = session.profile.salon_id;
  const supabase = await createClient();

  const row = {
    salon_id: salonId,
    name: input.name,
    category: input.category,
    description: input.description,
    price: input.price,
    duration_minutes: input.durationMinutes,
    consent_template_id: input.consentTemplateId || null,
    /*
     * Every column written explicitly, including the ones not in use. An
     * omitted key becomes an explicit NULL in PostgREST, and here that is
     * actually what is wanted -- an unused rate column must be null, not a
     * stale figure left over from a previous basis.
     */
    commission_basis: input.commissionBasis === "" ? null : input.commissionBasis,
    commission_rate:
      input.commissionBasis === "percentage"
        ? Number((input.commissionPercent / 100).toFixed(4))
        : null,
    commission_fixed:
      input.commissionBasis === "fixed_per_service" ? input.commissionFixed : null,
  };

  const { data: saved, error } = serviceId
    ? await supabase.from("services").update(row).eq("id", serviceId).select("id").maybeSingle()
    : await supabase.from("services").insert(row).select("id").single();

  if (error) {
    if (error.code === "23505") {
      return { errors: { name: "Another live service already uses that name." } };
    }
    return { message: error.message };
  }
  if (!saved) return { message: "That service no longer exists." };

  // Replace the qualified-staff set. RLS scopes both statements to this salon,
  // and the composite foreign key rejects any staff id from another one.
  await supabase.from("service_staff").delete().eq("service_id", saved.id);
  if (input.staffIds.length > 0) {
    const { error: staffError } = await supabase.from("service_staff").insert(
      input.staffIds.map((staffId) => ({
        salon_id: salonId,
        service_id: saved.id,
        staff_id: staffId,
      })),
    );
    if (staffError) return { message: staffError.message };
  }

  await logAudit(session, {
    action: serviceId ? AUDIT_ACTIONS.SERVICE_UPDATED : AUDIT_ACTIONS.SERVICE_CREATED,
    entityType: "service",
    entityId: saved.id,
    metadata: {
      name: input.name,
      price: input.price,
      duration_minutes: input.durationMinutes,
      qualified_staff: input.staffIds.length,
    },
  });

  revalidatePath("/dashboard/services");
  return { success: serviceId ? "Service updated." : `${input.name} added.` };
}

export async function setServiceActiveAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "services");

  const serviceId = String(formData.get("serviceId") ?? "");
  const isActive = formData.get("isActive") === "true";
  if (!serviceId) return;

  const supabase = await createClient();
  const { data: updated } = await supabase
    .from("services")
    .update({ is_active: isActive })
    .eq("id", serviceId)
    .select("name")
    .maybeSingle();

  if (updated) {
    await logAudit(session, {
      action: isActive ? AUDIT_ACTIONS.SERVICE_RESTORED : AUDIT_ACTIONS.SERVICE_ARCHIVED,
      entityType: "service",
      entityId: serviceId,
      metadata: { name: updated.name },
    });
  }

  revalidatePath("/dashboard/services");
}

/* -------------------------------------------------------------------------- */
/* Deals                                                                       */
/* -------------------------------------------------------------------------- */

export async function saveDealAction(
  _prevState: CatalogueFormState,
  formData: FormData,
): Promise<CatalogueFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "services");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = dealSchema.safeParse({
    name: formData.get("name"),
    dealType: formData.get("dealType"),
    value: formData.get("value"),
    startsOn: formData.get("startsOn"),
    endsOn: formData.get("endsOn"),
    serviceIds: formData.getAll("serviceIds").map(String),
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const input = parsed.data;
  const dealId = nullableUuid(formData.get("dealId"));
  const salonId = session.profile.salon_id;
  const supabase = await createClient();

  const row = {
    salon_id: salonId,
    name: input.name,
    deal_type: input.dealType,
    value: input.value,
    starts_on: input.startsOn,
    ends_on: input.endsOn,
  };

  const { data: saved, error } = dealId
    ? await supabase.from("deals").update(row).eq("id", dealId).select("id").maybeSingle()
    : await supabase.from("deals").insert(row).select("id").single();

  if (error) return { message: error.message };
  if (!saved) return { message: "That deal no longer exists." };

  await supabase.from("deal_services").delete().eq("deal_id", saved.id);
  if (input.serviceIds.length > 0) {
    const { error: linkError } = await supabase.from("deal_services").insert(
      input.serviceIds.map((serviceId) => ({
        salon_id: salonId,
        deal_id: saved.id,
        service_id: serviceId,
      })),
    );
    if (linkError) return { message: linkError.message };
  }

  await logAudit(session, {
    action: dealId ? AUDIT_ACTIONS.DEAL_UPDATED : AUDIT_ACTIONS.DEAL_CREATED,
    entityType: "deal",
    entityId: saved.id,
    metadata: {
      name: input.name,
      deal_type: input.dealType,
      value: input.value,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
    },
  });

  revalidatePath("/dashboard/services");
  return { success: dealId ? "Deal updated." : `${input.name} created.` };
}

export async function archiveDealAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "services");

  const dealId = String(formData.get("dealId") ?? "");
  if (!dealId) return;

  const supabase = await createClient();
  const { data: updated } = await supabase
    .from("deals")
    .update({ is_active: false })
    .eq("id", dealId)
    .select("name")
    .maybeSingle();

  if (updated) {
    await logAudit(session, {
      action: AUDIT_ACTIONS.DEAL_ARCHIVED,
      entityType: "deal",
      entityId: dealId,
      metadata: { name: updated.name },
    });
  }

  revalidatePath("/dashboard/services");
}

/* -------------------------------------------------------------------------- */
/* Consent templates                                                           */
/* -------------------------------------------------------------------------- */

export async function saveConsentTemplateAction(
  _prevState: CatalogueFormState,
  formData: FormData,
): Promise<CatalogueFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "services");
  } catch (error) {
    return { message: (error as Error).message };
  }

  // The statements arrive as one per line, which is the quickest way for an
  // owner to transcribe a consent sheet they already have on paper.
  const items = String(formData.get("items") ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label) => ({ label, isRequired: true }));

  const parsed = consentTemplateSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? "",
    requiresMedicalHistory: formData.get("requiresMedicalHistory") === "on",
    items,
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const input = parsed.data;
  const templateId = nullableUuid(formData.get("templateId"));
  const salonId = session.profile.salon_id;
  const supabase = await createClient();

  const row = {
    salon_id: salonId,
    name: input.name,
    description: input.description,
    requires_medical_history: input.requiresMedicalHistory,
  };

  const { data: saved, error } = templateId
    ? await supabase
        .from("consent_templates")
        .update(row)
        .eq("id", templateId)
        .select("id")
        .maybeSingle()
    : await supabase.from("consent_templates").insert(row).select("id").single();

  if (error) return { message: error.message };
  if (!saved) return { message: "That template no longer exists." };

  // Template items are replaced wholesale. Already-signed forms are unaffected:
  // they snapshot their wording into consent_form_responses at signing time.
  await supabase.from("consent_template_items").delete().eq("template_id", saved.id);

  const { error: itemsError } = await supabase.from("consent_template_items").insert(
    input.items.map((item, index) => ({
      salon_id: salonId,
      template_id: saved.id,
      label: item.label,
      is_required: item.isRequired,
      sort_order: index,
    })),
  );
  if (itemsError) return { message: itemsError.message };

  await logAudit(session, {
    action: templateId
      ? AUDIT_ACTIONS.CONSENT_TEMPLATE_UPDATED
      : AUDIT_ACTIONS.CONSENT_TEMPLATE_CREATED,
    entityType: "consent_template",
    entityId: saved.id,
    metadata: { name: input.name, statements: input.items.length },
  });

  revalidatePath("/dashboard/services");
  return { success: templateId ? "Template updated." : `${input.name} created.` };
}

export async function archiveConsentTemplateAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "services");

  const templateId = String(formData.get("templateId") ?? "");
  if (!templateId) return;

  const supabase = await createClient();
  const { data: updated } = await supabase
    .from("consent_templates")
    .update({ is_active: false })
    .eq("id", templateId)
    .select("name")
    .maybeSingle();

  if (updated) {
    await logAudit(session, {
      action: AUDIT_ACTIONS.CONSENT_TEMPLATE_ARCHIVED,
      entityType: "consent_template",
      entityId: templateId,
      metadata: { name: updated.name },
    });
  }

  revalidatePath("/dashboard/services");
}
