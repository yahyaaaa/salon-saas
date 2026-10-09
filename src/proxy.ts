import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { supabasePublishableKey, supabaseUrl } from "@/lib/env";

/**
 * Runs before every matched request.
 *
 * Two jobs:
 *   1. Refresh the Supabase session and write the rotated cookies onto the
 *      response, so Server Components (which cannot set cookies) always see a
 *      valid session.
 *   2. A coarse signed-in / signed-out gate on route groups.
 *
 * This is a convenience gate, not the security boundary. Role checks live in
 * `@/lib/auth/session` and the real enforcement is Row Level Security in
 * Postgres -- a request that slips past here still cannot read another tenant.
 */

/** Routes reachable without a session. */
const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password"];

/** Auth plumbing that must stay reachable in both states. */
const ALWAYS_ALLOWED_PREFIXES = ["/auth/"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // Responses that set auth cookies must never be cached by a CDN,
        // or one user's token could be served to another.
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Do not remove: this call is what refreshes the session cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (ALWAYS_ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return response;
  }

  if (!user && !isPublicPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.search = "";
    // Remember where they were headed so login can send them back.
    if (pathname !== "/") redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && isPublicPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/dashboard";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files -- without this the auth
     * check would also run for CSS, JS and images and block them from loading.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
