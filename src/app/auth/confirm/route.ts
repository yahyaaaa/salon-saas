import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * Landing point for emailed auth links that carry their token in the QUERY
 * string -- a customised template using {{ .TokenHash }}, or a PKCE code.
 *
 * Supabase's DEFAULT templates do not: they point at GoTrue's own
 * `/auth/v1/verify`, which redirects here with the session in a URL fragment
 * that no server can read. Those fall through to `/auth/callback`, which
 * handles them in the browser. Browsers carry a fragment across a redirect
 * when the target has none of its own, so the tokens survive the hop.
 *
 * Kept as a route handler rather than folded into that page because
 * exchanging a token here sets the session cookie, which a server component
 * cannot do.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next") ?? "/dashboard";

  // Only ever redirect within this app -- never to a caller-supplied origin.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  const supabase = await createClient();

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) {
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent(error.message)}`, origin),
      );
    }
    // An invited user has no password yet, so send them to set one.
    return NextResponse.redirect(
      new URL(type === "invite" ? "/accept-invite" : next, origin),
    );
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent(error.message)}`, origin),
      );
    }
    return NextResponse.redirect(new URL(next, origin));
  }

  /*
   * Nothing in the query. Either the token is in the fragment -- the default
   * template -- or the link really is incomplete. Hand it to the client page,
   * which can tell the two apart; this route cannot, because it never sees a
   * fragment.
   */
  return NextResponse.redirect(
    new URL(`/auth/callback?next=${encodeURIComponent(next)}`, origin),
  );
}
