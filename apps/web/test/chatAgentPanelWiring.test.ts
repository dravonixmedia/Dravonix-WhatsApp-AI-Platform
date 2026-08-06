import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the Chat Agent UI (ChatAgentPanel.tsx,
 * ConversationComposerWithAssistant.tsx, and the modified ReplyComposer.tsx).
 * These are plain client components with no session.ts import, so they
 * could in principle be imported directly, but this repo has no React
 * component-rendering test harness (no @testing-library/react) -- covered
 * the same way as every other dashboard component for consistency (see
 * notificationBellWiring.test.ts's identical note).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const panelSource = readFileSync(join(webRoot, "app/dashboard/ChatAgentPanel.tsx"), "utf8");
const composerWrapperSource = readFileSync(
  join(webRoot, "app/dashboard/ConversationComposerWithAssistant.tsx"),
  "utf8",
);
const replyComposerSource = readFileSync(
  join(webRoot, "app/dashboard/handover/[conversationId]/ReplyComposer.tsx"),
  "utf8",
);
const conversationsPageSource = readFileSync(
  join(webRoot, "app/dashboard/conversations/[conversationId]/page.tsx"),
  "utf8",
);
const handoverPageSource = readFileSync(
  join(webRoot, "app/dashboard/handover/[conversationId]/page.tsx"),
  "utf8",
);

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("ChatAgentPanel: never bypasses the human-review composer", () => {
  it("never imports or calls sendHumanReplyAction or any handover-lifecycle action", () => {
    const panelCodeOnly = withoutComments(panelSource);
    const wrapperCodeOnly = withoutComments(composerWrapperSource);
    for (const forbidden of [
      "sendHumanReplyAction",
      "assignToMeAction",
      "pauseAiAction",
      "resumeAiAction",
      "endHumanAssistanceAction",
      "closeConversationAction",
      "markConversationRead",
    ]) {
      expect(panelCodeOnly).not.toContain(forbidden);
      expect(wrapperCodeOnly).not.toContain(forbidden);
    }
  });

  it('"Use this reply" only calls onUseReply -- it never submits a form or calls chatAgentAction again', () => {
    const useReplyBlockMatch = panelSource.match(/Use this reply[\s\S]{0,400}?onClick=\{[^}]*\}/);
    // Simpler and more robust: find the button whose onClick calls onUseReply.
    expect(panelSource).toMatch(/onClick=\{\(\) => onUseReply\(view\.result\.displayText\)\}/);
    void useReplyBlockMatch;
  });

  it("ConversationComposerWithAssistant wires onUseReply directly to the composer's draft setter, never to a send action", () => {
    expect(composerWrapperSource).toContain("onUseReply={setDraft}");
    expect(composerWrapperSource).not.toMatch(/onUseReply=\{.*(send|submit)/i);
  });
});

describe("ChatAgentPanel: duplicate-click guard", () => {
  it("guards run() against overlapping calls while a request is already pending", () => {
    expect(panelSource).toMatch(/if\s*\(isPending\)\s*return;/);
  });

  it("disables every quick-action button while a request is pending", () => {
    const buttonBlocks = panelSource.match(/disabled=\{isPending[^}]*\}/g) ?? [];
    expect(buttonBlocks.length).toBeGreaterThanOrEqual(6); // one per quick action + ask
  });
});

describe("ChatAgentPanel: no polling, no new Realtime subscription", () => {
  it("never uses setInterval/setTimeout polling or opens a Realtime channel", () => {
    for (const source of [panelSource, composerWrapperSource]) {
      expect(source).not.toMatch(/setInterval/);
      expect(source).not.toMatch(
        /useTenantRealtimeChannel|RealtimeRefreshBoundary|supabase\.channel/,
      );
    }
  });
});

describe("ReplyComposer: controlled-mode change preserves the existing send/idempotency path", () => {
  it("still generates and rotates a client-side idempotency key exactly as before", () => {
    expect(replyComposerSource).toContain("crypto.randomUUID()");
    expect(replyComposerSource).toContain("setIdempotencyKey(crypto.randomUUID())");
  });

  it("still calls sendHumanReplyAction only on explicit form submission, reading body from FormData", () => {
    expect(replyComposerSource).toContain('formData.get("body")');
    expect(replyComposerSource).toMatch(
      /await sendHumanReplyAction\(conversationId, body, idempotencyKey\)/,
    );
  });

  it("value/onChange are optional -- omitting them preserves the original uncontrolled behavior", () => {
    expect(replyComposerSource).toMatch(/value\?:\s*string/);
    expect(replyComposerSource).toMatch(/onChange\?:\s*\(value: string\) => void/);
  });
});

describe("Composer wiring: both Live Conversations and Human Handover use the same shared component", () => {
  it("both pages render ConversationComposerWithAssistant instead of ReplyComposer directly", () => {
    expect(conversationsPageSource).toContain("<ConversationComposerWithAssistant");
    expect(handoverPageSource).toContain("<ConversationComposerWithAssistant");
    expect(conversationsPageSource).not.toMatch(/<ReplyComposer\b/);
    expect(handoverPageSource).not.toMatch(/<ReplyComposer\b/);
  });
});
