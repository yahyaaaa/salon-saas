"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { assertModule, assertRole, requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { checkoutSchema, fieldErrors, voidReceiptSchema } from "@/lib/validation";
import { submittedValues } from "@/lib/form-values";
import type { CheckoutLine } from "@/lib/types/database";

export interface PosFormState {
  message?: string;
  success?: string;
  errors?: Record<string, string>;
  /** Echoed back so a rejected sale keeps its basket. See submittedValues(). */
  values?: Record<string, string>;
}

/**
 * Take payment.
 *
 * Everything monetary is computed by `create_receipt()` inside Postgres, which
 * re-reads prices from the catalogue and re-checks the caller's role. This
 * action's whole job is to marshal "what was done" and relay the outcome; it
 * deliberately has no total to get wrong.
 */
export async function checkoutAction(
  _prevState: PosFormState,
  formData: FormData,
): Promise<PosFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "pos");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const values = submittedValues(formData);

  let lines: unknown = [];
  try {
    lines = JSON.parse(String(formData.get("lines") ?? "[]"));
  } catch {
    return { message: "The basket could not be read. Please try again.", values };
  }

  // A customer rung up for the first time is created by create_receipt(), in
  // the same transaction as the sale -- so a refused sale leaves no profile
  // behind. The name and phone travel with the checkout rather than being
  // written first.
  const wantsNewCustomer = String(formData.get("customerMode") ?? "existing") === "new";
  const newCustomerName = String(formData.get("newCustomerName") ?? "").trim();
  const newCustomerPhone = String(formData.get("newCustomerPhone") ?? "").trim();

  if (wantsNewCustomer) {
    if (newCustomerName.length < 2) {
      return { errors: { newCustomerName: "Enter the customer's name" }, values };
    }
    if (newCustomerPhone.replace(/[^0-9]/g, "").length < 6) {
      return { errors: { newCustomerPhone: "Enter a valid phone number" }, values };
    }
  }

  const parsed = checkoutSchema.safeParse({
    customerId: wantsNewCustomer ? null : formData.get("customerId"),
    dealId: formData.get("dealId") || null,
    paymentMethod: formData.get("paymentMethod"),
    cashAmount: formData.get("cashAmount") || 0,
    cardAmount: formData.get("cardAmount") || 0,
    transferAmount: formData.get("transferAmount") || 0,
    loyaltyRedeem: formData.get("loyaltyRedeem") || 0,
    notes: formData.get("notes") ?? "",
    appointmentId: formData.get("appointmentId") || null,
    lines,
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };

  const input = parsed.data;
  const supabase = await createClient();

  const { data: receiptId, error } = await supabase.rpc("create_receipt", {
    p_customer_id: input.customerId ?? null,
    p_payment_method: input.paymentMethod,
    p_cash_amount: input.cashAmount,
    p_card_amount: input.cardAmount,
    p_transfer_amount: input.transferAmount,
    p_loyalty_redeem: input.loyaltyRedeem,
    p_deal_id: input.dealId || null,
    p_notes: input.notes,
    p_lines: input.lines.map(
      (line): CheckoutLine => ({
        service_id: line.serviceId,
        staff_id: line.staffId,
        quantity: line.quantity,
        appointment_id: line.appointmentId || null,
      }),
    ),
    p_new_customer_name: wantsNewCustomer ? newCustomerName : null,
    p_new_customer_phone: wantsNewCustomer ? newCustomerPhone : null,
    // Linking the sale to the visit is what nets off any deposit already taken
    // and lets the completed appointment show its bill.
    p_appointment_id: input.appointmentId || null,
  });

  if (error) {
    // The function raises with wording already written for the front desk.
    // The basket comes back with it -- a refused sale should not have to be
    // rung up again from scratch.
    const friendly = error.message.replace(/^.*?:\s*/, "");
    if (error.code === "23505" || friendly.includes("already uses that phone")) {
      return { errors: { customerConflict: friendly }, values };
    }
    return { message: friendly, values };
  }

  revalidatePath("/dashboard/pos");
  redirect(`/dashboard/pos/${receiptId}`);
}

/** Void a receipt. Owner only, reason required — both re-checked in Postgres. */
export async function voidReceiptAction(
  _prevState: PosFormState,
  formData: FormData,
): Promise<PosFormState> {
  const session = await requireSession();
  try {
    assertRole(session, "owner");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = voidReceiptSchema.safeParse({
    receiptId: formData.get("receiptId"),
    reason: formData.get("reason"),
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.rpc("void_receipt", {
    p_receipt_id: parsed.data.receiptId,
    p_reason: parsed.data.reason,
  });

  if (error) return { message: error.message.replace(/^.*?:\s*/, "") };

  revalidatePath("/dashboard/pos");
  revalidatePath(`/dashboard/pos/${parsed.data.receiptId}`);
  return { success: "Receipt voided. The original stays on the record." };
}

/**
 * The customer's current loyalty balance, for the till to show before it
 * offers redemption. Read through the RLS-bound client, so it is necessarily
 * a customer of the caller's own salon.
 */
export async function loyaltyBalanceAction(customerId: string): Promise<number> {
  const session = await requireSession();
  assertModule(session, "pos");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("customer_loyalty_balance", {
    p_customer_id: customerId,
  });

  if (error) return 0;
  return Math.max(0, Number(data ?? 0));
}
