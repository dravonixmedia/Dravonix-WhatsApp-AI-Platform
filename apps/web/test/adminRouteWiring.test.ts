import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Lightweight route-wiring regression coverage for the major Super Admin
 * pages (P1 stabilization: the deadline-recovery audit found no test at all
 * for most of these). This repo has no @testing-library/react harness (see
 * notificationBellWiring.test.ts/adminFoundationSafety.test.ts's identical
 * note), so this follows the same established style: read each page's
 * source and assert on it, rather than rendering.
 *
 * /admin/billing, /admin/invoices, and /admin/payments already have
 * dedicated coverage in adminBillingOperationsAuth.test.ts and are not
 * duplicated here. /admin itself (platform counts, no stale copy) and
 * /admin/companies/[id] are covered by adminFoundationSafety.test.ts.
 *
 * Each page here is checked for the three failure modes the audit called
 * out: a broken/placeholder page that never queries real data, a page that
 * accidentally re-implements its own (possibly divergent) Super Admin
 * authorization check instead of relying on app/admin/layout.tsx's single
 * enforcement point, and stale "not implemented" copy left behind after the
 * feature was actually built.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function pageSource(relativePath: string): string {
  return readFileSync(join(webRoot, "app/admin", relativePath, "page.tsx"), "utf8");
}

const PAGES = [
  "companies",
  "usage",
  "audit",
  "subscriptions",
  "entitlements",
  "plans",
  "support-access",
  "support-requests",
] as const;

describe.each(PAGES)("/admin/%s route wiring", (page) => {
  const source = pageSource(page);

  it("is wired to the real, shared Supabase server client -- not a placeholder or a mock", () => {
    expect(source).toContain('createServerSupabaseClient } from "../../../lib/supabase/server.js"');
  });

  it("does not re-implement its own Super Admin authorization check -- relies on app/admin/layout.tsx's single enforcement point", () => {
    expect(source).not.toContain("getPlatformSession");
    expect(source).not.toContain("platformRole");
  });

  it("contains no stale 'not implemented' / 'coming soon' placeholder copy", () => {
    expect(source.toLowerCase()).not.toMatch(/not (yet )?implemented|coming soon/);
  });
});

describe("/admin/support-requests specifically", () => {
  it("delegates its data fetch to a real repository/action module, not an inline placeholder query", () => {
    const source = pageSource("support-requests");
    expect(source).toMatch(/from ".*supportRequests|adminSupport/);
  });
});
