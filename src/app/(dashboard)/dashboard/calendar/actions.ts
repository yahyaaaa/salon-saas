"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AUDIT_ACTIONS, logAudit } from "@/lib/audit";
import { assertModule, assertRole, requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { submittedValues } from "@/lib/form-values";
import { salonTimeToInstant } from "@/lib/time";
import {
  appointmentEditSchema,
  bookingSchema,
  fieldErrors,
  paymentSchema,
  refundPaymentSchema,
  rescheduleSchema,
  resolveAppointmentSchema,
} from "@/lib/validation";

export interface BookingFormState {
  message?: string;
  success?: string;
  errors?: Record<string, string>;
  /**
   * Echoed back on every rejected submission, so one bad field does not cost
   * the user everything else they typed. See submittedValues().
   */
  values?: Record<string, string>;
}

/** Postgres exclusion-constraint violation: the slot is already taken. */
const CONFLICT = "23P01";

function friendlyBookingError(error: { code?: string; message: string }): string {
  if (error.code === CONFLICT) {
    return "That team member is already booked for part of that slot. Pick another time, or book it as a walk-in.";
  }
  // Guard-rail triggers raise plain exceptions; their wording is already
  // written for the person at the front desk.
  return error.message.replace(/^.*?:\s*/, "");
}

/**
 * Book an appointment.
 *
 * Everything that matters happens inside `create_appointment()`: the customer
 * (if they are new), the appointment, and its service lines are written by one
 * transaction. That is the point -- a booking refused for an unqualified
 * therapist or a clashing slot used to leave a freshly created customer behind.
 *
 * Durations and prices are read from the catalogue there too. The front desk
 * may override the total or apply a discount, because quoting a package price
 * is a real thing salons do; it cannot set a line's price.
 */
export async function createBookingAction(
  _prevState: BookingFormState,
  formData: FormData,
): Promise<BookingFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "calendar");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const values = submittedValues(formData);

  let lines: unknown = [];
  try {
    lines = JSON.parse(String(formData.get("lines") ?? "[]"));
  } catch {
    return { message: "The service list could not be read. Please try again.", values };
  }

  const wantsNewCustomer = String(formData.get("customerMode") ?? "existing") === "new";

  const parsed = bookingSchema.safeParse({
    customerId: wantsNewCustomer ? null : formData.get("customerId"),
    newCustomerName: formData.get("newCustomerName") ?? "",
    newCustomerPhone: formData.get("newCustomerPhone") ?? "",
    isNewCustomer: wantsNewCustomer,
    staffId: formData.get("staffId"),
    date: formData.get("date"),
    time: formData.get("time"),
    notes: formData.get("notes") ?? "",
    isWalkIn: formData.get("isWalkIn") === "on",
    discount: formData.get("discount") || 0,
    quotedTotal: formData.get("quotedTotal") ?? "",
    lines,
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };

  const input = parsed.data;
  const supabase = await createClient();
  const startsAt = salonTimeToInstant(input.date, input.time, session.salon.timezone);

  const { error } = await supabase.rpc("create_appointment", {
    p_customer_id: input.customerId ?? null,
    p_new_customer_name: input.isNewCustomer ? input.newCustomerName : null,
    p_new_customer_phone: input.isNewCustomer ? input.newCustomerPhone : null,
    p_staff_id: input.staffId,
    p_starts_at: startsAt.toISOString(),
    p_notes: input.notes,
    p_is_walk_in: input.isWalkIn,
    p_discount: input.discount,
    p_quoted_total: input.quotedTotal === "" ? null : Number(input.quotedTotal),
    p_lines: input.lines.map((line) => ({
      service_id: line.serviceId,
      quantity: line.quantity,
    })),
  });

  if (error) {
    const friendly = friendlyBookingError(error);
    // A duplicate phone is the new customer's problem, so point at that field
    // rather than putting it in the banner where it reads as a system failure.
    if (error.code === "23505" || friendly.includes("already uses that phone")) {
      return { errors: { customerConflict: friendly }, values };
    }
    return { message: friendly, values };
  }

  revalidatePath("/dashboard/calendar");
  return { success: "Appointment booked." };
}

/**
 * Move an appointment to another slot or another therapist.
 * The duration is preserved; the exclusion constraint still applies.
 */
export async function rescheduleAction(
  _prevState: BookingFormState,
  formData: FormData,
): Promise<BookingFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "calendar");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = rescheduleSchema.safeParse({
    appointmentId: formData.get("appointmentId"),
    staffId: formData.get("staffId"),
    date: formData.get("date"),
    time: formData.get("time"),
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("appointments")
    .select("id, starts_at, ends_at, status")
    .eq("id", parsed.data.appointmentId)
    .maybeSingle();

  if (!existing) return { message: "That appointment could not be found." };
  if (["completed", "cancelled", "no_show"].includes(existing.status)) {
    return { message: `A ${existing.status.replace("_", "-")} appointment cannot be moved.` };
  }

  const durationMs =
    new Date(existing.ends_at).getTime() - new Date(existing.starts_at).getTime();
  const startsAt = salonTimeToInstant(parsed.data.date, parsed.data.time, session.salon.timezone);
  const endsAt = new Date(startsAt.getTime() + durationMs);

  const { error } = await supabase
    .from("appointments")
    .update({
      staff_id: parsed.data.staffId,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .eq("id", parsed.data.appointmentId);

  if (error) return { message: friendlyBookingError(error) };

  await logAudit(session, {
    action: AUDIT_ACTIONS.APPOINTMENT_RESCHEDULED,
    entityType: "appointment",
    entityId: parsed.data.appointmentId,
    metadata: {
      from: existing.starts_at,
      to: startsAt.toISOString(),
      staff_id: parsed.data.staffId,
    },
  });

  revalidatePath("/dashboard/calendar");
  return { success: "Appointment moved." };
}

/** Confirm or complete. The timestamps are stamped by the database trigger. */
export async function advanceStatusAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "calendar");

  const appointmentId = String(formData.get("appointmentId") ?? "");
  const raw = String(formData.get("status") ?? "");

  // Only these two transitions are driven from a plain button. Cancelling and
  // no-shows need a reason, so they go through resolveAppointmentAction.
  const advanceable = ["confirmed", "completed"] as const;
  const status = advanceable.find((s) => s === raw);
  if (!appointmentId || !status) return;

  const supabase = await createClient();
  const { data: updated } = await supabase
    .from("appointments")
    .update({ status })
    .eq("id", appointmentId)
    .select("id, customer_id, staff_id, starts_at")
    .maybeSingle();

  if (updated) {
    await logAudit(session, {
      action:
        status === "confirmed"
          ? AUDIT_ACTIONS.APPOINTMENT_CONFIRMED
          : AUDIT_ACTIONS.APPOINTMENT_COMPLETED,
      entityType: "appointment",
      entityId: appointmentId,
      metadata: {
        customer_id: updated.customer_id,
        staff_id: updated.staff_id,
        starts_at: updated.starts_at,
      },
    });
  }

  revalidatePath("/dashboard/calendar");
}

/**
 * Cancel or mark a no-show. Both need a reason: the brief requires it, the
 * database enforces it with a check constraint, and reporting reads it.
 */
export async function resolveAppointmentAction(
  _prevState: BookingFormState,
  formData: FormData,
): Promise<BookingFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "calendar");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = resolveAppointmentSchema.safeParse({
    appointmentId: formData.get("appointmentId"),
    status: formData.get("status"),
    reason: formData.get("reason"),
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("appointments")
    .update({ status: parsed.data.status, resolution_reason: parsed.data.reason })
    .eq("id", parsed.data.appointmentId)
    .select("id, customer_id, staff_id, starts_at")
    .maybeSingle();

  if (error) return { message: friendlyBookingError(error) };
  if (!updated) return { message: "That appointment could not be found." };

  await logAudit(session, {
    action:
      parsed.data.status === "cancelled"
        ? AUDIT_ACTIONS.APPOINTMENT_CANCELLED
        : AUDIT_ACTIONS.APPOINTMENT_NO_SHOW,
    entityType: "appointment",
    entityId: parsed.data.appointmentId,
    metadata: {
      customer_id: updated.customer_id,
      staff_id: updated.staff_id,
      starts_at: updated.starts_at,
      reason: parsed.data.reason,
    },
  });

  revalidatePath("/dashboard/calendar");
  return { success: parsed.data.status === "cancelled" ? "Appointment cancelled." : "No-show recorded." };
}

/* -------------------------------------------------------------------------- */
/* Editing a booking                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Change the services or the price on a booking that has not happened yet.
 *
 * Everything is recomputed by `update_appointment_services()`: the subtotal,
 * the slot length and the agreed price all come from the catalogue, the
 * therapist-qualification check re-runs, and the new price cannot fall below
 * what the customer has already paid. Nothing here does arithmetic.
 */
export async function editAppointmentAction(
  _prevState: BookingFormState,
  formData: FormData,
): Promise<BookingFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "calendar");
  } catch (error) {
    return { message: (error as Error).message };
  }

  let lines: { serviceId: string; quantity: number }[] = [];
  try {
    lines = JSON.parse(String(formData.get("lines") ?? "[]"));
  } catch {
    lines = [];
  }

  const parsed = appointmentEditSchema.safeParse({
    appointmentId: formData.get("appointmentId"),
    discount: formData.get("discount") || 0,
    quotedTotal: formData.get("quotedTotal") ?? "",
    lines,
  });

  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error), values: submittedValues(formData) };
  }

  const input = parsed.data;
  const supabase = await createClient();

  const { error } = await supabase.rpc("update_appointment_services", {
    p_appointment_id: input.appointmentId,
    p_lines: input.lines.map((l) => ({ service_id: l.serviceId, quantity: l.quantity })),
    p_discount: input.discount,
    p_quoted_total: input.quotedTotal === "" ? null : input.quotedTotal,
  });

  if (error) {
    return { message: friendlyBookingError(error), values: submittedValues(formData) };
  }

  revalidatePath("/dashboard/calendar");
  revalidatePath(`/dashboard/calendar/${input.appointmentId}`);
  return { success: "Booking updated." };
}

/* -------------------------------------------------------------------------- */
/* Payments                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Take a deposit or an instalment against a booking.
 *
 * Note what this does NOT do: it does not touch the appointment's status. A
 * visit that is fully paid in advance is still only "booked" until the work
 * happens, and a completed visit can still be owed for. Service and settlement
 * are two independent axes -- see the migration.
 */
export async function recordPaymentAction(
  _prevState: BookingFormState,
  formData: FormData,
): Promise<BookingFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "calendar");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = paymentSchema.safeParse({
    appointmentId: formData.get("appointmentId"),
    amount: formData.get("amount"),
    method: formData.get("method"),
    paidOn: formData.get("paidOn") ?? "",
    note: formData.get("note") ?? "",
  });

  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error), values: submittedValues(formData) };
  }

  const input = parsed.data;
  const supabase = await createClient();

  /*
   * A date with no time is midday in the salon's zone, not midnight: midnight
   * lands on the previous day in any zone ahead of UTC, which would file
   * yesterday's takings under the day before.
   */
  const paidAt =
    input.paidOn === ""
      ? null
      : salonTimeToInstant(input.paidOn, "12:00", session.salon.timezone).toISOString();

  const { error } = await supabase.rpc("record_payment", {
    p_appointment_id: input.appointmentId,
    p_amount: input.amount,
    p_method: input.method,
    p_paid_at: paidAt,
    p_note: input.note,
  });

  if (error) {
    return {
      message: error.message.replace(/^.*?:\s*/, ""),
      values: submittedValues(formData),
    };
  }

  revalidatePath("/dashboard/calendar");
  revalidatePath(`/dashboard/calendar/${input.appointmentId}`);
  return { success: "Payment recorded." };
}

/** Give a payment back. Owner-only and reason-required, as voiding is. */
export async function refundPaymentAction(
  _prevState: BookingFormState,
  formData: FormData,
): Promise<BookingFormState> {
  const session = await requireSession();
  try {
    assertRole(session, "owner");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = refundPaymentSchema.safeParse({
    paymentId: formData.get("paymentId"),
    reason: formData.get("reason"),
  });

  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error), values: submittedValues(formData) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("refund_payment", {
    p_payment_id: parsed.data.paymentId,
    p_reason: parsed.data.reason,
  });

  if (error) {
    return {
      message: error.message.replace(/^.*?:\s*/, ""),
      values: submittedValues(formData),
    };
  }

  const appointmentId = String(formData.get("appointmentId") ?? "");
  revalidatePath("/dashboard/calendar");
  if (appointmentId) revalidatePath(`/dashboard/calendar/${appointmentId}`);
  return { success: "Refund recorded." };
}

/**
 * Mark the work done and go straight to the till.
 *
 * The brief's shape, decided deliberately: completing PROMPTS checkout rather
 * than requiring it. A visit can be completed and left unpaid -- the front desk
 * sees the outstanding balance on the appointment -- and a visit can be paid in
 * full before the work happens. Tying the two together would mean a therapist
 * cannot record that they did the job until the customer settles up.
 */
export async function completeAndCheckOutAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "calendar");

  const appointmentId = String(formData.get("appointmentId") ?? "");
  if (!appointmentId) return;

  const supabase = await createClient();

  // A zero-row update is not an error in PostgREST, so the result is checked
  // rather than the absence of an error trusted.
  const { data: updated } = await supabase
    .from("appointments")
    .update({ status: "completed" })
    .eq("id", appointmentId)
    .in("status", ["booked", "confirmed"])
    .select("id, customer_id, staff_id, starts_at")
    .maybeSingle();

  if (updated) {
    await logAudit(session, {
      action: AUDIT_ACTIONS.APPOINTMENT_COMPLETED,
      entityType: "appointment",
      entityId: appointmentId,
      metadata: {
        customer_id: updated.customer_id,
        staff_id: updated.staff_id,
        starts_at: updated.starts_at,
      },
    });
  }

  revalidatePath("/dashboard/calendar");
  // Already-completed visits land here too, which is right: the reason to be
  // on this path at all is to get the bill raised.
  redirect(`/dashboard/pos?appointment=${appointmentId}`);
}
