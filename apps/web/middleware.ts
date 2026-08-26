import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseConnectionConfig } from "./lib/supabase/env.js";

/**
 * Refreshes the Supabase session on every request (Human Handover Inbox
 * final plan section 15) and redirects unauthenticated /dashboard/* or
 * /admin/* requests to /login. This is the only place session *refresh*
 * happens -- Server Components/Actions only read the (already-refreshed)
 * cookie via createServerSupabaseClient.
 *
 * /admin/* is included here (Phase 7A) purely so Super Admin sessions get
 * the same rolling cookie refresh /dashboard/* already gets -- this is
 * session-refresh infrastructure only. Role authorization (super_admin vs.
 * everyone else) is never decided here; that remains entirely
 * app/admin/layout.tsx's job via getPlatformSession(), which independently
 * re-verifies the caller against Supabase Auth and platform_members on
 * every request regardless of what this middleware does.
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request });
  const { url, anonKey } = getSupabaseConnectionConfig();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Never trust a locally-decoded JWT here -- getUser() re-verifies against
  // Supabase Auth on every call, which is what actually constitutes the
  // "refresh" (a stale/expired session is detected and cleared here).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isSessionProtectedRoute =
    request.nextUrl.pathname.startsWith("/dashboard") ||
    request.nextUrl.pathname.startsWith("/admin");
  if (isSessionProtectedRoute && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirectedFrom", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*"],
};
