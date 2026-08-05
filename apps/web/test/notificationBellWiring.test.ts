import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the notification bell / Human Handover nav
 * badge wiring (Issue 1 -- see loadNotificationSummary and
 * SupabaseHandoverRepository.countHandoverBadge/handoverItemNeedsAttention
 * for the actual counting logic, covered behaviorally in
 * notificationsRepository.test.ts and packages/handover/test/priority.test.ts).
 * app/dashboard/layout.tsx and NavLinks.tsx can't be imported directly here:
 * layout.tsx transitively imports lib/session.ts, whose
 * getDashboardSession() is wrapped in React's cache() and throws outside
 * Next's server-component runtime (see navItems.test.ts's identical note).
 * NotificationBell.tsx has no such import and could in principle be
 * imported, but this repo has no React component-rendering test harness
 * (no @testing-library/react), so it's covered the same way for
 * consistency.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const layoutSource = readFileSync(join(webRoot, "app/dashboard/layout.tsx"), "utf8");
const bellSource = readFileSync(join(webRoot, "app/dashboard/NotificationBell.tsx"), "utf8");
const navLinksSource = readFileSync(join(webRoot, "app/dashboard/NavLinks.tsx"), "utf8");

describe("notification bell wiring", () => {
  it("derives company-wide unread data from loadNotificationSummary, scoped to the session's own activeCompanyId", () => {
    expect(layoutSource).toContain("loadNotificationSummary(supabase, session.activeCompanyId)");
  });

  it("never accepts a company id from anywhere other than the server-derived session", () => {
    // The only company-id-shaped identifier passed into any repository call
    // in this file must be session.activeCompanyId -- never a request
    // param, cookie value, or client-supplied prop.
    const companyIdArgs = [...layoutSource.matchAll(/companyId:\s*([\w.]+)/g)].map((m) => m[1]);
    for (const arg of companyIdArgs) {
      expect(arg).toBe("session.activeCompanyId");
    }
  });

  it("derives the Human Handover nav/bell badge count via the shared handoverItemNeedsAttention predicate, not a narrower ad hoc state check", () => {
    expect(layoutSource).toContain("handoverInboxItems.filter(handoverItemNeedsAttention).length");
  });

  it("passes the real notification summary and handover-attention lists into NotificationBell", () => {
    expect(layoutSource).toMatch(
      /<NotificationBell\s+totalUnreadCustomerMessages=\{notificationSummary\.totalUnreadCustomerMessages\}/,
    );
    expect(layoutSource).toContain("unreadConversations={notificationSummary.unreadConversations}");
    expect(layoutSource).toContain("pendingHandoverRequests={pendingHandoverRequests}");
    expect(layoutSource).toContain("unassignedHandovers={unassignedHandovers}");
  });

  it("the bell badge is hidden entirely at zero and capped visually via formatBadgeCount", () => {
    expect(bellSource).toMatch(/totalUnreadCustomerMessages > 0 \?/);
    expect(bellSource).toContain("formatBadgeCount(totalUnreadCustomerMessages)");
  });

  it("the bell never fetches or polls on its own -- no fetch/setInterval calls", () => {
    expect(bellSource).not.toMatch(/\bfetch\(/);
    expect(bellSource).not.toMatch(/setInterval/);
  });

  it("the Human Handover nav badge is hidden at zero and capped via formatBadgeCount", () => {
    expect(navLinksSource).toMatch(/handoverBadgeCount > 0 \?/);
    expect(navLinksSource).toContain("formatBadgeCount(handoverBadgeCount)");
  });

  it("mounts a tenant-scoped RealtimeRefreshBoundary in the shell so the bell/nav badge (and every wrapped page) stay live -- not just pages with their own list-specific boundary", () => {
    expect(layoutSource).toMatch(
      /<RealtimeRefreshBoundary\s+namespace="dashboard-shell"\s+scopeId=\{session\.activeCompanyId\}\s+accessToken=\{session\.accessToken\}\s+watches=\{DASHBOARD_SHELL_WATCHES\}/,
    );
  });
});
