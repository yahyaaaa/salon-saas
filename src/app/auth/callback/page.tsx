import Link from "next/link";
import type { Metadata } from "next";

import { AuthCallback } from "./auth-callback";
import { Card } from "@/components/ui";

export const metadata: Metadata = { title: "Signing you in" };

/**
 * Where every emailed auth link lands.
 *
 * WHY THIS IS A CLIENT PAGE AND NOT A ROUTE HANDLER. Supabase's default email
 * templates point at GoTrue's own `/auth/v1/verify`, which verifies the token
 * and then redirects the browser here with the session in a URL FRAGMENT:
 *
 *     /auth/callback#access_token=...&refresh_token=...&type=invite
 *
 * A fragment is never sent to the server. No route handler, proxy or server
 * component can see it, however it is written -- so the exchange has to happen
 * in the browser. `/auth/confirm` was a route handler expecting `token_hash`
 * in the query string, which is what a CUSTOMISED template produces; against
 * the default template it saw an empty query and sent everyone to
 * "Invalid or incomplete link".
 *
 * It handles all three shapes, so it works whether or not the email templates
 * are ever customised.
 *
 * The chrome is repeated from the (auth) layout rather than shared: this route
 * lives under /auth alongside the confirm handler, which is not in that group.
 */
export default function AuthCallbackPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-8 flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
          S
        </span>
        <span className="text-base font-semibold tracking-tight text-ink-900">
          Salon Suite
        </span>
      </Link>

      <main className="w-full max-w-md">
        <Card className="p-6">
          <AuthCallback />
        </Card>
      </main>
    </div>
  );
}
