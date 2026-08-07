import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * /dashboard/draiva -- the dedicated DRAIVA workspace. Static source
 * assertions, matching every other dashboard page test in this repo (see
 * navItems.test.ts's identical note on why: getDashboardSession() is
 * wrapped in React's cache(), an RSC-only API; DraivaWorkspace.tsx is a
 * plain client component with no such import and no React-render test
 * harness exists in this repo either -- covered the same way for
 * consistency, see chatAgentPanelWiring.test.ts's identical note).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const pageSource = readFileSync(join(webRoot, "app/dashboard/draiva/page.tsx"), "utf8");
const workspaceSource = readFileSync(
  join(webRoot, "app/dashboard/draiva/DraivaWorkspace.tsx"),
  "utf8",
);

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("dedicated DRAIVA page", () => {
  it("exists as a real route with a default export", () => {
    expect(pageSource).toContain("export default async function DraivaPage");
  });

  it("requires capabilities.canReplyToConversations server-side -- the same permission the composer's Ask DRAIVA gate and chatAgentAction itself already require -- and never relies on the sidebar simply not showing the link", () => {
    expect(pageSource).toMatch(/if \(!capabilities\.canReplyToConversations\)/);
    // The unauthorized branch returns before ever loading the conversation
    // list or rendering the workspace.
    const guardBlock = pageSource.match(
      /if \(!capabilities\.canReplyToConversations\) \{[\s\S]*?\n {2}\}/,
    );
    expect(guardBlock).not.toBeNull();
    expect(guardBlock?.[0]).not.toContain("listConversations");
    expect(guardBlock?.[0]).not.toContain("DraivaWorkspace");
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

  it("selecting a conversation renders the existing ChatAgentPanel component, imported unmodified -- never a second Chat Agent UI implementation", () => {
    expect(workspaceSource).toContain('import { ChatAgentPanel } from "../ChatAgentPanel.js"');
    expect(workspaceSource).toContain("<ChatAgentPanel");
    expect(workspaceSource).toMatch(/conversationId=\{selected\.conversationId\}/);
  });

  it("switching the selected conversation re-keys ChatAgentPanel by conversationId -- the same prop that already drives its own internal reset-on-change effect, so no separate 'clear previous result' logic is duplicated here", () => {
    // ChatAgentPanel's own conversationId-keyed useEffect (verified by
    // chatAgentPanelWiring.test.ts) is the single source of truth for
    // clearing state on conversation switch; this file only needs to pass
    // the newly selected id through, never reimplement the reset.
    expect(workspaceSource).not.toMatch(/setLatestAiDraft|setLatestAssistantResult|setView\(/);
  });

  it("never imports or calls chatAgentAction directly -- only ChatAgentPanel (which already owns that call) is used", () => {
    const codeOnly = withoutComments(workspaceSource);
    expect(codeOnly).not.toMatch(/chatAgentAction/);
  });

  it("the standalone workspace cannot call outbound WhatsApp send -- no sendHumanReplyAction/whatsapp/fetch reference anywhere in it", () => {
    const codeOnly = withoutComments(workspaceSource) + withoutComments(pageSource);
    expect(codeOnly).not.toMatch(/sendHumanReplyAction/);
    expect(codeOnly).not.toMatch(/whatsapp/i);
    expect(codeOnly).not.toMatch(/fetch\(/);
  });

  it("'Use in reply' safely copies the result instead of inventing a fragile cross-route draft-transfer mechanism, and a separate 'Open conversation' link is always available", () => {
    expect(workspaceSource).toContain("navigator.clipboard.writeText");
    expect(workspaceSource).toContain("Open conversation");
    expect(workspaceSource).toMatch(
      /href=\{`\/dashboard\/conversations\/\$\{selected\.conversationId\}`\}/,
    );
  });

  it("never auto-navigates away to Live Conversations on its own -- selecting a conversation only updates local state", () => {
    const codeOnly = withoutComments(workspaceSource);
    expect(codeOnly).not.toMatch(/useRouter/);
    expect(codeOnly).not.toMatch(/router\.push/);
  });

  it("shows the required empty state before a conversation is selected", () => {
    expect(workspaceSource).toContain('title="Select a conversation"');
    expect(workspaceSource).toContain(
      "Choose a conversation from the list to let DRAIVA review its context.",
    );
  });

  it("carries the approved DRAIVA page identity and brand colors -- DRAIVA/cyan, subtitle/white, Dravonix/cyan", () => {
    expect(pageSource).toContain('className="dvx-draiva-page-title"');
    expect(pageSource).toContain(">DRAIVA<");
    expect(pageSource).toContain("AI Conversation Assistant by");
    expect(pageSource).toMatch(/<span className="dvx-draiva-brand">\s*Dravonix\s*<\/span>/);
  });

  it("reveals the workspace pane on mobile via the same dvx-workspace-detail--active marker the real conversation-detail pages use -- not a second responsive mechanism", () => {
    expect(workspaceSource).toMatch(
      /dvx-workspace-detail\$\{selected \? " dvx-workspace-detail--active" : ""\}/,
    );
  });

  it("never adds polling -- no setInterval/setTimeout in either file, and exactly one RealtimeRefreshBoundary (for the conversation list), not a duplicate subscription per selection", () => {
    for (const source of [pageSource, workspaceSource]) {
      expect(source).not.toMatch(/setInterval/);
      expect(source).not.toMatch(/setTimeout/);
    }
    expect(pageSource.match(/<RealtimeRefreshBoundary/g)?.length ?? 0).toBe(1);
    expect(workspaceSource).not.toContain("RealtimeRefreshBoundary");
  });

  it("never hardcodes an email address or literal role check", () => {
    for (const source of [pageSource, workspaceSource]) {
      expect(source).not.toMatch(/["'][\w.+-]+@[\w.-]+\.\w+["']/);
      expect(source).not.toMatch(/role\s*===?\s*["']/);
    }
  });
});
