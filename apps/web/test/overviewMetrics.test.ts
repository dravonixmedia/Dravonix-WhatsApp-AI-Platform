import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for Overview's handover-related KPIs (Issue 2):
 * pending handover requests, active human assistance, unassigned handovers,
 * unread customer messages, and AI-paused conversations must each be a
 * distinct, separately-queried metric -- never one hidden inside another's
 * definition. app/dashboard/page.tsx can't be imported directly here (it
 * transitively imports lib/session.ts, whose getDashboardSession() is
 * wrapped in React's cache() and throws outside Next's server-component
 * runtime -- see navItems.test.ts's identical note).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const pageSource = readFileSync(join(webRoot, "app/dashboard/page.tsx"), "utf8");

describe("Overview handover metrics", () => {
  it("labels the pending-handover KPI distinctly from active human assistance, never reusing the old ambiguous 'Handover requests' label", () => {
    expect(pageSource).toContain('label: "Pending handover requests"');
    expect(pageSource).toContain('label: "Active human assistance"');
  });

  it("counts active human assistance as a distinct query for state = human_active", () => {
    expect(pageSource).toMatch(/\.eq\("state",\s*"human_active"\)/);
    expect(pageSource).toContain("activeHumanAssistance: activeHuman.count");
  });

  it("counts pending handover requests as handover_requested/queued_for_agent, regardless of assignment", () => {
    expect(pageSource).toMatch(/\.in\("state",\s*\["handover_requested",\s*"queued_for_agent"\]\)/);
    expect(pageSource).toContain("pendingHandoverRequests: pending.count");
  });

  it("shows a real unread-customer-message KPI backed by loadNotificationSummary, the same function backing the bell", () => {
    expect(pageSource).toContain("loadNotificationSummary(supabase, companyId)");
    expect(pageSource).toContain(
      "unreadCustomerMessages: notificationSummary.totalUnreadCustomerMessages",
    );
    expect(pageSource).toContain('label: "Unread customer messages"');
  });

  it("keeps AI-paused as its own distinct ai_mode-based query, unrelated to handover state", () => {
    expect(pageSource).toMatch(/\.eq\("ai_mode",\s*"paused"\)/);
    expect(pageSource).toContain('label: "AI-paused conversations"');
  });

  it("runs five distinct conversation-state/notification queries in parallel, not five reads of the same query", () => {
    const promiseAllBlock = pageSource.match(/await Promise\.all\(\[[\s\S]*?\n {4}\]\);/);
    expect(promiseAllBlock).not.toBeNull();
    const block = promiseAllBlock?.[0] ?? "";
    expect(block).toMatch(/\.neq\("state",\s*"closed"\)/);
    expect(block).toMatch(/\.in\("state",\s*\["handover_requested",\s*"queued_for_agent"\]\)/);
    expect(block).toMatch(/\.eq\("state",\s*"human_active"\)/);
    expect(block).toMatch(/\.eq\("ai_mode",\s*"paused"\)/);
    expect(block).toContain("loadNotificationSummary(supabase, companyId)");
  });
});
