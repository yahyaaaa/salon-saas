"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { siteUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { fieldErrors, setPasswordSchema, signInSchema, signUpSchema } from "@/lib/validation";
import { submittedValues } from "@/lib/form-values";

export interface FormState {
  message?: string;
  errors?: Record<string, string>;
  /**
   * What the user typed, echoed back.
   *
   * React resets an uncontrolled form once its action resolves, so without
   * this a rejected submission would come back blank and everything would have
   * to be re-entered to fix one field.
   */
  values?: Record<string, string>;
  /** Set when signup succeeded but the account still needs email confirmation. */
  pendingConfirmation?: string;
}

/**
 * Create a salon and its owner.
 *
 * The salon row, its settings row, the owner profile and the first audit entry
 * are all created by the `handle_new_user` trigger inside the same transaction
 * as the auth user. That means there is no window in which an auth user exists
 * without a tenant -- if the trigger raises, the signup itself fails.
 */
export async function signUpAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = signUpSchema.safeParse({
    salonName: formData.get("salonName"),
    businessType: formData.get("businessType"),
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
    country: formData.get("country"),
    timezone: formData.get("timezone"),
    currency: formData.get("currency"),
  });

  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error), values: submittedValues(formData) };
  }

  const input = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      // Same reasoning as the invitation: the default template returns the
      // session in a fragment, which only the browser can read.
      emailRedirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent("/dashboard")}`,
      // Read by the handle_new_user trigger to build the salon.
      data: {
        full_name: input.fullName,
        salon_name: input.salonName,
        business_type: input.businessType,
        country: input.country,
        timezone: input.timezone,
        currency: input.currency,
      },
    },
  });

  if (error) {
    return { message: error.message, values: submittedValues(formData) };
  }

  // Email confirmation is on: no session yet, so tell them to check their inbox.
  if (!data.session) {
    return { pendingConfirmation: input.email };
  }

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function signInAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // Deliberately vague: do not confirm whether an email exists.
    return { message: "Incorrect email or password." };
  }

  const next = formData.get("next");
  const destination =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
      ? next
      : "/dashboard";

  revalidatePath("/", "layout");
  redirect(destination);
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}

/**
 * Finishes an invited user's onboarding: they arrive with a session created by
 * the invite link, and set their own password and name here.
 *
 * Their profile, salon and role were already assigned by the trigger when the
 * invite created their auth user -- none of that is client-supplied.
 */
export async function acceptInviteAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = setPasswordSchema.safeParse({
    fullName: formData.get("fullName"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { message: "Your invitation link has expired. Ask your salon owner to resend it." };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
    data: { full_name: parsed.data.fullName },
  });

  if (error) {
    return { message: error.message };
  }

  // The trigger seeds full_name from the invite; the user's own spelling wins.
  const { error: profileError } = await supabase
    .from("profiles")
    .update({ full_name: parsed.data.fullName })
    .eq("id", user.id);

  if (profileError) {
    return { message: profileError.message };
  }

  revalidatePath("/", "layout");
  redirect("/dashboard");
}
