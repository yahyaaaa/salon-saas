/**
 * Environment access with a clear failure message instead of a stray
 * "Invalid URL" a few frames deep in the Supabase client.
 *
 * Supabase is mid-migration from the legacy `anon`/`service_role` JWTs to the
 * newer `sb_publishable_` / `sb_secret_` keys, so both spellings are accepted.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value.trim();
}

export function supabaseUrl(): string {
  return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
}

/** Browser-safe key. Subject to Row Level Security. */
export function supabasePublishableKey(): string {
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", key);
}

/**
 * Server-only key that BYPASSES Row Level Security. Only the invite flow uses
 * it, and only to reach the Supabase Auth admin API -- never to read tenant data.
 */
export function supabaseSecretKey(): string {
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return required("SUPABASE_SECRET_KEY", key);
}

/** Absolute origin used to build auth redirect URLs. */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  // Vercel sets this on every deployment, which keeps preview URLs working.
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;

  return "http://localhost:3000";
}
