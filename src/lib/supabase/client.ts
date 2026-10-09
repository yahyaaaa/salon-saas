"use client";

import { createBrowserClient } from "@supabase/ssr";

import { supabasePublishableKey, supabaseUrl } from "@/lib/env";
import type { Database } from "@/lib/types/database";

/**
 * Browser Supabase client. Every query it makes is subject to Row Level
 * Security, so it can only ever see the signed-in user's own salon.
 */
export function createClient() {
  return createBrowserClient<Database>(supabaseUrl(), supabasePublishableKey());
}
