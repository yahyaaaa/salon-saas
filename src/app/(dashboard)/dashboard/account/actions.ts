"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { fieldErrors, profileUpdateSchema } from "@/lib/validation";

export interface AccountFormState {
  message?: string;
  success?: string;
  errors?: Record<string, string>;
}

/**
 * A user editing their own name and phone.
 *
 * Role, salon and active status are deliberately absent: the `profiles_update_self`
 * policy scopes the row, and `guard_profile_changes` rejects any attempt to move
 * tenant, change one's own role, or reactivate oneself.
 */
export async function updateAccountAction(
  _prevState: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const session = await requireSession();

  const parsed = profileUpdateSchema.safeParse({
    fullName: formData.get("fullName"),
    phone: formData.get("phone") ?? "",
  });

  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      full_name: parsed.data.fullName,
      phone: parsed.data.phone || null,
    })
    .eq("id", session.userId);

  if (error) {
    return { message: error.message };
  }

  revalidatePath("/dashboard", "layout");
  return { success: "Profile updated." };
}
