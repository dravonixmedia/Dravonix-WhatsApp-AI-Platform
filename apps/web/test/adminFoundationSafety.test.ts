import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Super Admin foundation (Phase 1): /admin/* is a new, independent route
 * tree gated by getPlatformSession(), deliberately separate from
 * /dashboard/*'s getDashboardSession(). These are static source assertions
 * (matching the existing dashboardRedesignSafety.test.ts /
 * sendHumanReplyGuard.test.ts convention) rather than a live Supabase
 * integration test, since getPlatformSession() calls the real Supabase Auth
 * SDK -- the properties that matter here (server-side gating present, no
 * accidental coupling to the customer dashboard's session/company logic) are
 * fully checkable by inspecting what the source actually calls.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

describe("Super Admin foundation: /admin is server-side gated and independent of /dashboard", () => {
  it("app/admin/layout.tsx resolves the caller via getPlatformSession, not getDashboardSession", () => {
    const source = readSource("app/admin/layout.tsx");
    expect(source).toContain("getPlatformSession");
    // getDashboardSession may be mentioned only in prose (explaining the
    // deliberate separation) -- it must never be imported from
    // ../../lib/session.js.
    const importLines = source
      .split("\n")
      .filter((line) => line.includes('from "../../lib/session'));
    expect(importLines.some((line) => line.includes("getDashboardSession"))).toBe(false);
    expect(importLines.some((line) => line.includes("getPlatformSession"))).toBe(true);
  });

  it("app/admin/layout.tsx redirects an unauthenticated caller and never renders admin content for a null session", () => {
    const source = readSource("app/admin/layout.tsx");
    expect(source).toMatch(/if\s*\(\s*!session\s*\)\s*\{\s*redirect\(/);
  });

  it("app/admin/layout.tsx renders ForbiddenPage (not the admin shell) for any platformRole other than super_admin", () => {
    const source = readSource("app/admin/layout.tsx");
    expect(source).toMatch(
      /if\s*\(\s*session\.platformRole\s*!==\s*["']super_admin["']\s*\)\s*\{\s*return\s*<ForbiddenPage/,
    );
    // The forbidden branch must return before the sidebar/shell markup, and
    // must not itself contain any of the sidebar/nav content.
    const forbiddenFnSource = source.slice(
      source.indexOf("function ForbiddenPage"),
      source.indexOf("export default async function AdminLayout"),
    );
    expect(forbiddenFnSource).not.toContain("AdminSidebar");
    expect(forbiddenFnSource).not.toContain("logoutAction");
  });

  it("getPlatformSession (lib/session.ts) never queries company_members and is independent of getDashboardSession", () => {
    const source = readSource("lib/session.ts");
    expect(source).toContain("export const getPlatformSession");
    expect(source).toContain("export const getDashboardSession");

    const platformFnSource = source.slice(source.indexOf("export const getPlatformSession"));
    expect(platformFnSource).toContain("platform_members");
    expect(platformFnSource).not.toContain("company_members");
    expect(platformFnSource).not.toContain("NoCompanyAccessError");
  });

  it("getDashboardSession's own source is untouched by the platform-session addition -- still requires company_members and still throws NoCompanyAccessError", () => {
    const source = readSource("lib/session.ts");
    const dashboardFnSource = source.slice(
      source.indexOf("export const getDashboardSession"),
      source.indexOf("export interface PlatformSession"),
    );
    expect(dashboardFnSource).toContain("company_members");
    expect(dashboardFnSource).toContain("throw new NoCompanyAccessError()");
  });

  it("app/admin/page.tsx's platform-wide counts never filter by a company_id -- these are intentionally cross-tenant, relying on RLS is_platform_staff(), not a client-supplied scope", () => {
    const source = readSource("app/admin/page.tsx");
    expect(source).not.toMatch(/\.eq\(\s*["']company_id["']/);
  });

  it("the AdminSidebar's remaining placeholder items (Research, Settings) are not real <Link> routes -- only implemented sections are", () => {
    const source = readSource("app/admin/AdminSidebar.tsx");
    // NAV_ITEMS is data-mapped to a single <Link> in the JSX, so the source
    // contains one <Link> tag, not nine -- what must be nine is the number
    // of routes actually listed as data, one per implemented section.
    expect(source).toContain("<Link");
    const navItemsSection = source.slice(
      source.indexOf("const NAV_ITEMS"),
      source.indexOf("const PLACEHOLDER_ITEMS"),
    );
    const hrefMatches = navItemsSection.match(/href: "\/admin[^"]*"/g) ?? [];
    // Dashboard, Companies, Users & Roles, Plans, Subscriptions,
    // Entitlements, Usage, Audit Logs, Support Access, Support & Requests
    // (Phase 5) -- every route this pass actually built a real page for.
    expect(hrefMatches.length).toBe(10);
    expect(navItemsSection).toContain('href: "/admin"');
    expect(navItemsSection).toContain('href: "/admin/companies"');

    const placeholderRenderSection = source.slice(source.indexOf("{PLACEHOLDER_ITEMS.map"));
    expect(placeholderRenderSection).not.toContain("<Link");
  });
});
