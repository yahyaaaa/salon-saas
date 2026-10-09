import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { supabasePublishableKey, supabaseUrl } from "@/lib/env";
import type { Database } from "@/lib/types/database";

/**
 * Request-scoped Supabase client for Server Components, Server Actions and
 * Route Handlers. It carries the user's session cookies, so Row Level Security
 * applies: this client can only reach rows belonging to the caller's salon.
 *
 * This is the client that should be used for essentially all data access.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. That is fine: the proxy
          // (src/proxy.ts) refreshes the session on every request, so the
          // cookies are already up to date by the time we render.
        }
      },
    },
  });
}
