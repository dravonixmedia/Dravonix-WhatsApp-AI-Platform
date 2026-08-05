import type { CompanyRole } from "@dravonix/database";
import { cookies } from "next/headers";
import { cache } from "react";
import { createServerSupabaseClient } from "./supabase/server.js";

export const ACTIVE_COMPANY_COOKIE = "dvx_active_company";

export interface DashboardMembership {
  companyId: string;
  companyName: string;
  companySlug: string;
  role: CompanyRole;
  memberId: string;
}

export interface DashboardSession {
  userId: string;
  email: string | null;
  memberships: DashboardMembership[];
  activeCompanyId: string;
  activeMemberId: string;
  activeRole: CompanyRole;
  /**
   * The current session's access token, relayed to client components that
   * open a browser-side Supabase Realtime subscription (supabase.realtime.
   * setAuth(accessToken)) so postgres_changes events are filtered by the
   * connecting user's own RLS, not just a client-supplied filter string.
   * Never used for authorization decisions here or anywhere in this
   * module -- getUser() above is what actually validates the caller;
   * this is only relayed onward for the realtime handshake.
   */
  accessToken: string;
}

/** Thrown when a signed-in user has zero active company memberships. */
export class NoCompanyAccessError extends Error {
  constructor() {
    super("This account has no active company membership.");
    this.name = "NoCompanyAccessError";
  }
}

/**
 * Resolves the dashboard session for the current request (Human Handover
 * Inbox final plan section 15): live company_members query on every call
 * (never cached across requests -- React's cache() below only memoizes
 * *within* a single request's render, never across requests or users), an
 * HttpOnly active-company cookie treated only as a *hint* -- if it doesn't
 * match a currently-active membership, this falls back to the first active
 * membership and attempts to reset the cookie (a client can never force an
 * arbitrary company_id into effect this way, since the fallback always
 * re-derives from the live membership list). Returns null if there is no
 * signed-in user at all (middleware.ts already redirects that case for
 * /dashboard/*, but pages should not assume).
 *
 * Wrapped in React's cache(): every /dashboard/* route calls this once from
 * dashboard/layout.tsx and again from its own page.tsx -- without this, that
 * duplication meant two independent auth.getUser() round trips plus two
 * independent company_members queries per navigation (verified by reading
 * every call site). cache() is Next.js's documented per-request-only
 * memoization primitive for exactly this shape of duplicate call: the
 * memoized result is scoped to the current request's render and is never
 * reused for a different request or a different user.
 */
export const getDashboardSession = cache(async (): Promise<DashboardSession | null> => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // getSession() is used here only to relay the access token to client-side
  // Realtime subscriptions -- the authorization decision for this request was
  // already made above by getUser(), which revalidates against the auth
  // server rather than trusting a locally-decoded cookie.
  const {
    data: { session: rawSession },
  } = await supabase.auth.getSession();
  const accessToken = rawSession?.access_token ?? "";

  const { data: memberRows, error } = await supabase
    .from("company_members")
    .select("id, company_id, role, companies (name, slug)")
    .eq("user_id", user.id)
    .eq("is_active", true);
  if (error) throw error;

  const memberships: DashboardMembership[] = (memberRows ?? []).map((row) => {
    const company = Array.isArray(row.companies) ? row.companies[0] : row.companies;
    return {
      companyId: row.company_id as string,
      companyName: (company?.name as string | undefined) ?? "",
      companySlug: (company?.slug as string | undefined) ?? "",
      role: row.role as CompanyRole,
      memberId: row.id as string,
    };
  });

  const firstMembership = memberships[0];
  if (!firstMembership) {
    throw new NoCompanyAccessError();
  }

  const cookieStore = await cookies();
  const hint = cookieStore.get(ACTIVE_COMPANY_COOKIE)?.value;
  const active = memberships.find((m) => m.companyId === hint) ?? firstMembership;

  if (active.companyId !== hint) {
    try {
      cookieStore.set(ACTIVE_COMPANY_COOKIE, active.companyId, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      });
    } catch {
      // Called from a Server Component render, which cannot write cookies --
      // harmless, since this is only a hint and gets recomputed identically
      // on the next request until a Server Action can persist it.
    }
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    memberships,
    activeCompanyId: active.companyId,
    activeMemberId: active.memberId,
    activeRole: active.role,
    accessToken,
  };
});
