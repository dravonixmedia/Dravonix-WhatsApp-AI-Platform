import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * /dashboard/notifications -- the dedicated Notifications section (as
 * distinct from the top-right compact bell, which is unmodified). Static
 * source assertions, matching every other dashboard page test in this repo
 * (see navItems.test.ts's identical note on why: getDashboardSession() is
 * wrapped in React's cache(), an RSC-only API).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const pageSource = readFileSync(join(webRoot, "app/dashboard/notifications/page.tsx"), "utf8");

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("dedicated Notifications page", () => {
  it("is tenant-scoped: every data load reads from the caller's own session-derived company, never a client-supplied id", () => {
    expect(pageSource).toContain("loadNotificationSummary(supabase, session.activeCompanyId)");
    expect(pageSource).toContain("companyId: session.activeCompanyId");
    const companyIdArgs = [...pageSource.matchAll(/companyId:\s*([\w.]+)/g)].map((m) => m[1]);
    expect(companyIdArgs.length).toBeGreaterThan(0);
    for (const arg of companyIdArgs) {
      expect(arg).toBe("session.activeCompanyId");
    }
  });

  it("resolves the session server-side and renders nothing for an unauthenticated caller -- the same guard every other dashboard page uses", () => {
    expect(pageSource).toContain("await getDashboardSession()");
    expect(pageSource).toMatch(/if \(!session\)\s*return null;/);
  });

  it("reuses the exact same notification data sources as the top-right bell and the Human Handover nav badge -- never a second notification system", () => {
    expect(pageSource).toContain("loadNotificationSummary");
    expect(pageSource).toContain("listHandoverInbox");
    expect(pageSource).toContain("handoverItemNeedsAttention");
    // Never a second, independently-derived unread-count calculation --
    // both the "conversation" rows and the header numbers come from the
    // same repository call's return value, not a re-query.
    expect(pageSource).not.toMatch(/\.from\("messages"\)/);
    expect(pageSource).not.toMatch(/deriveUnreadCount/);
  });

  it("never adds polling -- no setInterval/setTimeout, and no second RealtimeRefreshBoundary (the shell's own boundary in layout.tsx already covers this route)", () => {
    expect(pageSource).not.toMatch(/setInterval/);
    expect(pageSource).not.toMatch(/setTimeout/);
    // A comment legitimately explains *why* no boundary is mounted here;
    // only executable code must never actually import/render one.
    expect(withoutComments(pageSource)).not.toContain("RealtimeRefreshBoundary");
  });

  it("offers exactly the four approved filters -- All, Unread, Conversations, Human Handover -- and invents no new notification category", () => {
    expect(pageSource).toMatch(/key:\s*"all"/);
    expect(pageSource).toMatch(/key:\s*"unread"/);
    expect(pageSource).toMatch(/key:\s*"conversations"/);
    expect(pageSource).toMatch(/key:\s*"handover"/);
    // No other filter keys/categories are introduced.
    const filterKeys = [...pageSource.matchAll(/key:\s*"(\w+)"/g)].map((m) => m[1]);
    for (const key of filterKeys) {
      expect(["all", "unread", "conversations", "handover"]).toContain(key);
    }
  });

  it("actions are limited to Open conversation / Open Human Handover / Mark as read -- markConversationReadAction is the existing, already-tested handover_mark_read action, never a new mutation", () => {
    expect(pageSource).toContain("markConversationReadAction");
    expect(pageSource).toContain('"Open conversation"');
    expect(pageSource).toContain('"Open Human Handover"');
    expect(pageSource).toContain("Mark as read");
    // No other mutation actions imported/called.
    const codeOnly = withoutComments(pageSource);
    for (const forbidden of [
      "sendHumanReplyAction",
      "assignToMeAction",
      "assignToTeamMemberAction",
      "pauseAiAction",
      "resumeAiAction",
      "endHumanAssistanceAction",
      "closeConversationAction",
    ]) {
      expect(codeOnly).not.toContain(forbidden);
    }
  });

  it("links each row to the real, existing detail route for its category -- /dashboard/conversations/[id] or /dashboard/handover/[id]", () => {
    expect(pageSource).toContain("`/dashboard/conversations/${row.conversationId}`");
    expect(pageSource).toContain("`/dashboard/handover/${row.conversationId}`");
  });

  it("never hardcodes an email address or literal role check", () => {
    expect(pageSource).not.toMatch(/["'][\w.+-]+@[\w.-]+\.\w+["']/);
    expect(pageSource).not.toMatch(/role\s*===?\s*["']/);
  });
});
