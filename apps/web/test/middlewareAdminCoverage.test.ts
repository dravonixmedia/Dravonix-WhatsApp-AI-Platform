import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 7A: the audit found middleware.ts's session-refresh matcher covered
 * /dashboard/* but not /admin/*, so Super Admin sessions never got the
 * rolling cookie refresh /dashboard/* sessions already got. These tests
 * prove the fix (matcher now includes /admin/:path*) without touching
 * authorization: middleware only ever decides "signed in or not" here --
 * app/admin/layout.tsx's getPlatformSession() remains the sole place that
 * decides "super_admin or not" (see adminActionsSafety.test.ts /
 * supabase/tests/rls_super_admin.sql for that boundary).
 */

let mockUser: { id: string } | null = { id: "user-1" };
const getUser = vi.fn(async () => ({ data: { user: mockUser } }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: () => getUser() },
  }),
}));

vi.mock("../lib/supabase/env.js", () => ({
  getSupabaseConnectionConfig: () => ({
    url: "https://example.supabase.co",
    anonKey: "anon-key",
  }),
}));

const { middleware, config } = await import("../middleware.js");

function requestFor(pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, "https://app.example.com"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { id: "user-1" };
});

describe("middleware matcher config", () => {
  it("covers /dashboard/:path* (unchanged)", () => {
    expect(config.matcher).toContain("/dashboard/:path*");
  });

  it("now also covers /admin/:path* (Phase 7A fix)", () => {
    expect(config.matcher).toContain("/admin/:path*");
  });

  it("does not widen coverage beyond /dashboard and /admin", () => {
    expect(config.matcher.sort()).toEqual(["/admin/:path*", "/dashboard/:path*"]);
  });
});

describe("middleware session-refresh behavior", () => {
  it("still redirects an unauthenticated /dashboard/* request to /login", async () => {
    mockUser = null;
    const response = await middleware(requestFor("/dashboard/leads"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirectedFrom")).toBe("/dashboard/leads");
  });

  it("now also redirects an unauthenticated /admin/* request to /login", async () => {
    mockUser = null;
    const response = await middleware(requestFor("/admin/companies"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirectedFrom")).toBe("/admin/companies");
  });

  it("lets an authenticated /admin/* request through (role is not decided here)", async () => {
    mockUser = { id: "user-1" };
    const response = await middleware(requestFor("/admin/companies"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets an authenticated /dashboard/* request through unchanged", async () => {
    mockUser = { id: "user-1" };
    const response = await middleware(requestFor("/dashboard/leads"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect an unauthenticated public route (e.g. /login itself)", async () => {
    mockUser = null;
    const response = await middleware(requestFor("/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("still calls supabase.auth.getUser() to force a real re-verification, never trusting a local cookie", async () => {
    await middleware(requestFor("/admin/companies"));
    expect(getUser).toHaveBeenCalledTimes(1);
  });
});
