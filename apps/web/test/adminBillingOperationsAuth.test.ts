import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 7A: /admin/billing, /admin/invoices, /admin/payments are new pages
 * inside the existing app/admin/* tree, which app/admin/layout.tsx already
 * gates to session.platformRole === "super_admin" specifically (proven
 * generically in adminFoundationSafety.test.ts). These pages introduce no
 * competing authorization check of their own -- that is the point: a
 * company_owner/company_admin/company_accounts/manager/team_leader/
 * sales_person has no platform_members row at all (company_role and
 * platform_role are stored in entirely separate tables -- see
 * lib/session.ts's getPlatformSession, which never queries company_members),
 * so every one of those roles is denied by the exact same generic
 * `session.platformRole !== "super_admin"` check that also denies
 * platform_support and platform_billing_admin (real platform_members rows,
 * just not super_admin). These tests prove (a) the three new pages live
 * where that gate applies and do not duplicate or weaken it, and (b) the
 * data-safety rules from the Phase 7A spec (no secrets, no raw payloads,
 * no client-trusted company id, server-only fetching).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

// Matches navItems.test.ts's convention: strip comments before asserting a
// term is genuinely absent from *code*, since these files' own explanatory
// header comments legitimately name the exact secrets/columns/roles they
// document as excluded.
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const NEW_PAGES = [
  "app/admin/billing/page.tsx",
  "app/admin/invoices/page.tsx",
  "app/admin/payments/page.tsx",
];

describe("Phase 7A admin pages: Super Admin authorization (inherited, not reimplemented)", () => {
  it.each(NEW_PAGES)("%s defines no competing session/role check of its own", (relativePath) => {
    const source = readSource(relativePath);
    // No import of getDashboardSession/getPlatformSession here -- the page
    // trusts the shared app/admin/layout.tsx gate above it in the tree,
    // exactly like every pre-existing admin page (companies, plans,
    // subscriptions, entitlements, usage, audit).
    expect(source).not.toContain("getDashboardSession");
    expect(source).not.toContain("getPlatformSession");
    expect(source).not.toContain("platformRole");
    // No service-role client -- every query runs as the caller's own
    // session (RLS-enforced), never a privilege-bypassing client.
    expect(source).not.toMatch(/service_role/i);
    expect(source).not.toContain("createServiceRoleClient");
  });

  it.each(NEW_PAGES)(
    "%s fetches all data server-side via createServerSupabaseClient",
    (relativePath) => {
      const source = readSource(relativePath);
      expect(source).toContain("createServerSupabaseClient");
      expect(source).toContain('export const dynamic = "force-dynamic"');
      // Server Component: no "use client" directive anywhere in the file.
      expect(source).not.toContain('"use client"');
    },
  );

  it("company_role (company_owner/company_admin/company_accounts/manager/team_leader/sales_person) has zero bearing on /admin access", () => {
    const layoutSource = readSource("app/admin/layout.tsx");
    const sessionSource = readSource("lib/session.ts");
    // The layout only ever branches on platformRole; company_role never
    // appears in the admin authorization path at all.
    expect(layoutSource).not.toContain("company_role");
    expect(layoutSource).not.toContain("companyRole");
    const platformFnSource = sessionSource.slice(
      sessionSource.indexOf("export const getPlatformSession"),
    );
    expect(platformFnSource).not.toContain("company_members");
    expect(platformFnSource).not.toContain("company_role");
  });

  it("platform_support and platform_billing_admin are denied by the same generic check as any other non-super_admin role -- not specially widened for the new pages", () => {
    const layoutSource = withoutComments(readSource("app/admin/layout.tsx"));
    // Exactly one string literal is ever compared against in actual code --
    // "super_admin". platform_support/platform_billing_admin are real
    // platform_role enum values (only mentioned in this file's explanatory
    // comments, stripped above) but neither is special-cased into a code
    // allow-list anywhere.
    expect(layoutSource).not.toContain("platform_support");
    expect(layoutSource).not.toContain("platform_billing_admin");
    expect(layoutSource).toMatch(/session\.platformRole\s*!==\s*["']super_admin["']/);
  });
});

/**
 * A "mutation form" here means a <form> wired to a Server Action (an
 * `action={...somethingAction}` prop, or an imported *Action identifier
 * used as a form action) -- the plain GET filter/search forms these pages
 * do have (no `action` prop at all, so they submit as a normal navigation
 * with query-string params) are not mutations and must not trip this check.
 */
function hasMutationFormOrActionImport(source: string): boolean {
  const hasBoundFormAction = /<form[^>]*\baction=\{/.test(source);
  const importsFromLibActions = /from\s+["'].*lib\/actions\//.test(source);
  return hasBoundFormAction || importsFromLibActions;
}

describe("Phase 7A /admin/payments: strict data-safety rules", () => {
  const rawSource = readSource("app/admin/payments/page.tsx");
  const source = withoutComments(rawSource);

  it("never selects or renders payment_attempts.raw_payload", () => {
    expect(source).not.toContain("raw_payload");
  });

  it("never references a Razorpay secret or webhook secret", () => {
    expect(source).not.toMatch(/RAZORPAY_KEY_SECRET/);
    expect(source).not.toMatch(/RAZORPAY_WEBHOOK_SECRET/);
  });

  it("never selects card or bank detail columns", () => {
    expect(source).not.toMatch(/card_number|cvv|bank_account|ifsc|account_number/i);
  });

  it("has no approve/reject/refund mutation form or Server Action import", () => {
    expect(hasMutationFormOrActionImport(rawSource)).toBe(false);
  });
});

describe("Phase 7A /admin/invoices: read-only, no mutation surface", () => {
  const rawSource = readSource("app/admin/invoices/page.tsx");

  it("has no edit/delete/mark-paid/refund/PDF mutation form or Server Action import", () => {
    expect(hasMutationFormOrActionImport(rawSource)).toBe(false);
  });
});

describe("Phase 7A /admin/billing: reuses the existing RPC, invents no new calculation", () => {
  const rawSource = readSource("app/admin/billing/page.tsx");

  it("calls admin_billing_lifecycle_overview and defines no competing SQL/RPC name", () => {
    expect(rawSource).toContain('rpc("admin_billing_lifecycle_overview")');
    expect(rawSource).not.toMatch(/\.rpc\(\s*["'](?!admin_billing_lifecycle_overview)/);
  });

  it("has no mutation form or Server Action import", () => {
    expect(hasMutationFormOrActionImport(rawSource)).toBe(false);
  });
});

describe("Phase 7A: no company_id from the browser is trusted for scoping these new admin reads", () => {
  it.each(NEW_PAGES)(
    "%s never reads a company id out of request input to scope its query",
    (relativePath) => {
      const source = readSource(relativePath);
      // The only per-company scoping input accepted is a free-text company
      // *name* search (resolved server-side against companies.name, then used
      // to build a company_id IN (...) list) -- never a raw id/uuid taken
      // directly off searchParams and used to bypass RLS-based scoping.
      expect(source).not.toMatch(/searchParams\.company_id/);
      expect(source).not.toMatch(/eq\(\s*"company_id",\s*(company|searchParams)/);
    },
  );
});
