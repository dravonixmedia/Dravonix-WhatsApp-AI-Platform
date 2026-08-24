import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * /dashboard/draiva -- the no-selection DRAIVA workspace route. Phase 4
 * replaced the old client-state-only DraivaWorkspace.tsx (deleted) with a
 * routed, Link-based conversation list (DraivaConversationList) shared with
 * /dashboard/draiva/[conversationId] -- see draivaConversationWorkspace.test.ts
 * for the selected-conversation route. Static source assertions, matching
 * every other dashboard page test in this repo (see navItems.test.ts's
 * identical note on why: getDashboardSession() is wrapped in React's
 * cache(), an RSC-only API, and no React-render test harness exists here).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const pageSource = readFileSync(join(webRoot, "app/dashboard/draiva/page.tsx"), "utf8");
const listSource = readFileSync(
  join(webRoot, "app/dashboard/draiva/DraivaConversationList.tsx"),
  "utf8",
);

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("dedicated DRAIVA page (no selection)", () => {
  it("exists as a real route with a default export", () => {
    expect(pageSource).toContain("export default async function DraivaPage");
  });

  it("requires capabilities.canReplyToConversations server-side -- the same permission the composer's Ask DRAIVA gate and chatAgentAction itself already require -- and never relies on the sidebar simply not showing the link", () => {
    expect(pageSource).toMatch(/if \(!capabilities\.canReplyToConversations\)/);
    const guardBlock = pageSource.match(
      /if \(!capabilities\.canReplyToConversations\) \{[\s\S]*?\n {2}\}/,
    );
    expect(guardBlock).not.toBeNull();
    expect(guardBlock?.[0]).not.toContain("listConversations");
    expect(guardBlock?.[0]).not.toContain("DraivaConversationList");
  });

  it("resolves the session server-side and renders nothing for an unauthenticated caller", () => {
    expect(pageSource).toContain("await getDashboardSession()");
    expect(pageSource).toMatch(/if \(!session\)\s*return null;/);
  });

  it("the conversation selector is company-scoped -- listConversations is called with session.activeCompanyId, never a client-supplied id", () => {
    expect(pageSource).toContain("listConversations(supabase");
    expect(pageSource).toContain("companyId: session.activeCompanyId");
    const companyIdArgs = [...pageSource.matchAll(/companyId:\s*([\w.]+)/g)].map((m) => m[1]);
    expect(companyIdArgs.length).toBeGreaterThan(0);
    for (const arg of companyIdArgs) {
      expect(arg).toBe("session.activeCompanyId");
    }
  });

  it("reuses the existing conversationsRepository query verbatim -- no second, duplicate conversation-list query is introduced", () => {
    expect(pageSource).toContain('from "../../../lib/repositories/conversationsRepository.js"');
    expect(pageSource).not.toMatch(/\.from\("conversations"\)/);
  });

  it("renders the shared DraivaConversationList with no active selection", () => {
    expect(pageSource).toContain(
      'import { DraivaConversationList } from "./DraivaConversationList.js"',
    );
    expect(pageSource).toContain("<DraivaConversationList");
    expect(pageSource).toMatch(/activeConversationId=\{null\}/);
  });

  it("each conversation row is a real <Link> to /dashboard/draiva/{conversationId} -- selecting a conversation is routing, not local state", () => {
    expect(listSource).toContain('import Link from "next/link"');
    expect(listSource).toMatch(/href=\{`\/dashboard\/draiva\/\$\{item\.conversationId\}`\}/);
  });

  it("the list never navigates to Live Conversations on its own", () => {
    const codeOnly = withoutComments(listSource);
    expect(codeOnly).not.toMatch(/\/dashboard\/conversations\//);
  });

  it("shows the required empty state before a conversation is selected, in both the center thread and the DRAIVA panel", () => {
    expect(pageSource).toContain('title="Select a conversation"');
    expect(pageSource).toMatch(/dvx-workspace-right/);
  });

  it("never auto-selects a conversation on the no-selection route", () => {
    expect(pageSource).not.toMatch(/redirect\(/);
  });

  it("never adds polling -- no setInterval/setTimeout, and exactly one RealtimeRefreshBoundary (for the conversation list), not a duplicate subscription per row", () => {
    for (const source of [pageSource, listSource]) {
      expect(source).not.toMatch(/setInterval/);
      expect(source).not.toMatch(/setTimeout/);
    }
    expect(pageSource.match(/<RealtimeRefreshBoundary/g)?.length ?? 0).toBe(1);
    expect(listSource).not.toContain("RealtimeRefreshBoundary");
  });

  it("carries the approved DRAIVA page identity and brand colors -- DRAIVA/cyan, subtitle/white, Dravonix/cyan", () => {
    expect(pageSource).toContain('className="dvx-draiva-page-title"');
    expect(pageSource).toContain(">DRAIVA<");
    expect(pageSource).toContain("AI Conversation Assistant by");
    expect(pageSource).toMatch(/<span className="dvx-draiva-brand">\s*Dravonix\s*<\/span>/);
  });

  it("never hardcodes an email address or literal role check", () => {
    for (const source of [pageSource, listSource]) {
      expect(source).not.toMatch(/["'][\w.+-]+@[\w.-]+\.\w+["']/);
      expect(source).not.toMatch(/role\s*===?\s*["']/);
    }
  });

  it("never queries a raw phone/wa_id column client-facing -- the list item's phone display is fully resolved by conversationsRepository already", () => {
    const codeOnly = withoutComments(listSource);
    expect(codeOnly).not.toMatch(/whatsapp_wa_id/);
    expect(codeOnly).not.toMatch(/phone_number/);
  });
});
