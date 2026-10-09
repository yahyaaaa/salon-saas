import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { supabaseSecretKey, supabaseUrl } from "@/lib/env";
import type { Database } from "@/lib/types/database";

/**
 * Service-role client. It BYPASSES Row Level Security entirely.
 *
 * Rules for this file, which hold for the whole project:
 *   - Only ever reached from server code that has already authorised the caller.
 *   - Only used for operations the Auth admin API requires (inviting a user,
 *     deleting a user). Never for reading or writing tenant data -- that always
 *     goes through `@/lib/supabase/server`, so RLS stays the enforcement layer.
 *   - Every call site must scope its work to a salon_id it has verified belongs
 *     to the acting user.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(supabaseUrl(), supabaseSecretKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
