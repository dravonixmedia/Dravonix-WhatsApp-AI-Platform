import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 4: /dashboard/draiva/[conversationId] -- the real three-column
 * workspace (list | WhatsApp thread | DRAIVA assistant). Static source
 * assertions, matching every other dashboard page/component test in this
 * repo (see chatAgentPanelWiring.test.ts's identical note on why: no React
 * component-rendering test harness exists here).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function read(relPath: string): string {
  return readFileSync(join(webRoot, relPath), "utf8");
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const draivaConvoPage = read("app/dashboard/draiva/[conversationId]/page.tsx");
const conversationsPage = read("app/dashboard/conversations/[conversationId]/page.tsx");
const handoverPage = read("app/dashboard/handover/[conversationId]/page.tsx");
const assistantColumn = read("app/dashboard/draiva/DraivaAssistantColumn.tsx");
const replyComposerSlot = read("app/dashboard/draiva/DraivaReplyComposerSlot.tsx");
const draftContext = read("app/dashboard/draiva/DraivaDraftContext.tsx");
const conversationList = read("app/dashboard/draiva/DraivaConversationList.tsx");

describe("Routing: conversationId is a route param, not client state", () => {
  it("the DRAIVA workspace route is keyed by a [conversationId] segment with a default export", () => {
    expect(draivaConvoPage).toContain("export default async function DraivaConversationPage");
    expect(draivaConvoPage).toMatch(/params: Promise<\{ conversationId: string \}>/);
    expect(draivaConvoPage).toContain("const { conversationId } = await params;");
  });

  it("every row in the list links to /dashboard/draiva/{conversationId} -- selecting a conversation is real navigation, so a direct URL, refresh, and browser back/forward all resolve to the same conversation", () => {
    expect(conversationList).toMatch(/href=\{`\/dashboard\/draiva\/\$\{item\.conversationId\}`\}/);
  });

  it("resolves the session and required capability server-side before loading anything conversation-specific, exactly like the no-selection route", () => {
    expect(draivaConvoPage).toContain("await getDashboardSession()");
    expect(draivaConvoPage).toMatch(/if \(!session\)\s*return null;/);
    expect(draivaConvoPage).toMatch(/if \(!capabilities\.canReplyToConversations\)/);
  });
});

describe("Cross-tenant / invalid conversation protection", () => {
  it("goes through the shared, tenant-checked loadConversationWorkspaceData -- the same entry point Live Conversations and Human Handover already use, never a second authorization path", () => {
    for (const source of [draivaConvoPage, conversationsPage, handoverPage]) {
      expect(source).toContain(
        'import { loadConversationWorkspaceData } from "../../conversationWorkspaceData.js"',
      );
      expect(source).toContain("loadConversationWorkspaceData(");
    }
  });

  it("never queries the conversations/contacts tables directly for the selected conversation -- only through the shared loader", () => {
    const codeOnly = withoutComments(draivaConvoPage);
    expect(codeOnly).not.toMatch(/\.from\("conversations"\)/);
    expect(codeOnly).not.toMatch(/\.from\("contacts"\)/);
    expect(codeOnly).not.toMatch(/whatsapp_wa_id/);
    expect(codeOnly).not.toMatch(/phone_number/);
  });

  it("passes session.activeCompanyId, never a client-supplied value, as the tenant scope", () => {
    expect(draivaConvoPage).toMatch(/companyId: session\.activeCompanyId/);
  });
});

describe("Thread integration: reuses ConversationThread and the Phase 3B scroll fix verbatim", () => {
  it("imports the shared ConversationThread component from the handover module, not a second implementation", () => {
    expect(draivaConvoPage).toContain(
      'import { ConversationThread } from "../../handover/[conversationId]/ConversationThread.js"',
    );
  });

  it("keys ConversationThread by conversationId (the Phase 3B remount fix), not by companyId", () => {
    const match = draivaConvoPage.match(/<ConversationThread\s+key=\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("conversationId");
  });

  it("passes the shared loader's thread.messages/thread.hasMore straight through, matching the other two conversation-detail routes", () => {
    expect(draivaConvoPage).toMatch(/initialMessages=\{thread\.messages\}/);
    expect(draivaConvoPage).toMatch(/initialHasMore=\{thread\.hasMore\}/);
  });

  it("never redefines scroll-position logic -- no useLayoutEffect/scrollTop assignment of its own", () => {
    const codeOnly = withoutComments(draivaConvoPage);
    expect(codeOnly).not.toMatch(/useLayoutEffect/);
    expect(codeOnly).not.toMatch(/\.scrollTop\s*=/);
  });
});

describe("Assistant context synchronization: switching conversations never leaks stale AI state", () => {
  it("DraivaAssistantColumn renders the existing ChatAgentPanel, imported unmodified -- never a second Chat Agent UI implementation", () => {
    expect(assistantColumn).toContain('import { ChatAgentPanel } from "../ChatAgentPanel.js"');
    expect(assistantColumn).toContain("<ChatAgentPanel");
    expect(assistantColumn).toMatch(/conversationId=\{conversationId\}/);
  });

  it("the page passes the route's conversationId straight through to DraivaAssistantColumn -- the same id driving the center thread", () => {
    expect(draivaConvoPage).toMatch(/<DraivaAssistantColumn conversationId=\{conversationId\} \/>/);
  });

  it("relies on ChatAgentPanel's own conversationId-keyed reset effect rather than re-implementing 'clear previous result' here", () => {
    const codeOnly = withoutComments(assistantColumn);
    expect(codeOnly).not.toMatch(/setLatestAiDraft|setLatestAssistantResult|setView\(/);
  });

  it("the shared draft (composer text) is reset per conversation via a provider mounted with key={conversationId}, mirroring ConversationThread's own remount fix", () => {
    expect(draivaConvoPage).toMatch(/<DraivaDraftProvider key=\{conversationId\}>/);
  });

  it("DraivaDraftContext throws if used outside its provider, rather than silently sharing draft state across an unrelated tree", () => {
    expect(draftContext).toMatch(
      /throw new Error\("useDraivaDraft must be used within a DraivaDraftProvider"\);/,
    );
  });
});

describe("Manual replies: no second composer, same send/authorization path", () => {
  it("DraivaReplyComposerSlot renders the existing ReplyComposer, not a new composer implementation", () => {
    expect(replyComposerSlot).toContain(
      'import { ReplyComposer } from "../handover/[conversationId]/ReplyComposer.js"',
    );
    expect(replyComposerSlot).toContain("<ReplyComposer");
  });

  it("never imports or calls sendHumanReplyAction directly -- only ReplyComposer (which already owns that call) is used", () => {
    for (const source of [replyComposerSlot, assistantColumn, draivaConvoPage]) {
      const codeOnly = withoutComments(source);
      expect(codeOnly).not.toMatch(/sendHumanReplyAction/);
    }
  });

  it("gates manual replies on conversation.state === 'human_active' AND capabilities.canReplyToConversations, exactly like Live Conversations", () => {
    expect(draivaConvoPage).toMatch(
      /conversation\.state === "human_active" && capabilities\.canReplyToConversations/,
    );
  });

  it("'Use in reply' fills the same shared draft the composer sends, via context -- never a clipboard workaround", () => {
    expect(assistantColumn).toContain("onUseReply={setDraft}");
    expect(assistantColumn).not.toMatch(/navigator\.clipboard/);
  });
});

describe("Pause/Resume AI and End/Close actions reuse existing Server Actions and capability gates verbatim", () => {
  it("imports pauseAiAction/resumeAiAction/endHumanAssistanceAction/closeConversationAction from the shared handover actions module -- no alternate DRAIVA-only mutation path", () => {
    expect(draivaConvoPage).toContain('from "../../../../lib/actions/handover.js"');
    for (const action of [
      "pauseAiAction",
      "resumeAiAction",
      "endHumanAssistanceAction",
      "closeConversationAction",
    ]) {
      expect(draivaConvoPage).toContain(action);
    }
  });

  it("gates Pause/Resume AI behind capabilities.canPauseResumeAi, matching Live Conversations", () => {
    expect(draivaConvoPage).toMatch(/capabilities\.canPauseResumeAi \?/);
  });

  it("gates End human assistance / Close conversation behind capabilities.canCloseConversations, matching the existing pages -- Sales Person and Company Accounts never see these buttons", () => {
    expect(draivaConvoPage).toMatch(/capabilities\.canCloseConversations &&/);
  });

  it("never hardcodes a role string to gate an action -- every gate goes through the shared capabilities object", () => {
    const codeOnly = withoutComments(draivaConvoPage);
    expect(codeOnly).not.toMatch(/role\s*===?\s*["']/);
  });
});

describe("Realtime: exactly one subscription for the selected conversation, matching the existing detail-page pattern", () => {
  it("mounts exactly one RealtimeRefreshBoundary, scoped to conversationId (detail watches), not the company-wide list watches", () => {
    expect(draivaConvoPage.match(/<RealtimeRefreshBoundary/g)?.length ?? 0).toBe(1);
    expect(draivaConvoPage).toMatch(/scopeId=\{conversationId\}/);
    expect(draivaConvoPage).toContain("CONVERSATION_DETAIL_WATCHES");
    expect(draivaConvoPage).not.toContain("CONVERSATIONS_LIST_WATCHES");
  });

  it("never opens a second Realtime channel/polling loop of its own in the new Phase 4 files", () => {
    for (const source of [draivaConvoPage, assistantColumn, replyComposerSlot, draftContext]) {
      expect(source).not.toMatch(/setInterval/);
      expect(source).not.toMatch(/supabase\.channel\(/);
    }
  });
});

describe("Mobile: reuses the existing dvx-workspace-detail--active responsive mechanism, plus a scoped assistant drawer toggle for phones/tablets", () => {
  it("marks the detail pane active with the same class the other two conversation-detail pages use -- no second mobile mechanism", () => {
    expect(draivaConvoPage).toContain(
      'className="dvx-workspace-detail dvx-workspace-detail--active"',
    );
  });

  it("DraivaAssistantColumn's mobile toggle only ever shows/hides via CSS classes scoped to dvx-draiva-assistant-wrap -- ChatAgentPanel itself is never unmounted by the toggle", () => {
    expect(assistantColumn).toContain("dvx-draiva-assistant-wrap");
    expect(assistantColumn).toMatch(/open=\{true\}/);
  });
});

describe("Right panel operates on the currently selected conversation only", () => {
  it("DraivaAssistantColumn takes conversationId as its only conversation-identifying prop", () => {
    expect(assistantColumn).toMatch(/\{ conversationId \}: \{ conversationId: string \}/);
  });
});
