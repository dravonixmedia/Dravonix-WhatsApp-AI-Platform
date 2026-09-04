import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the fix for a generic Human Handover / Live Conversations
 * conversation-switch stale-state bug (found while investigating a
 * service-window report for one contact, but not specific to that contact):
 * ConversationComposerWithAssistant -- and everything it renders,
 * ReplyComposer (draft, idempotencyKey, windowClosed,
 * canSendReengagementTemplate, templateSent, templateError) and
 * ChatAgentPanel (its own conversation-specific assistant/translation
 * state) -- held local React state with no conversationId-based remount
 * boundary. Both page.tsx call sites render it at the same tree position
 * regardless of which conversation is selected, so a client-side navigation
 * from conversation A to conversation B (e.g. via HandoverQueuePanel's
 * next/link items) reused the same component instance and carried A's
 * state into B's initial render, until the next server round-trip
 * recomputed it.
 *
 * No DOM-rendering stack exists in this repo (see
 * conversationThreadScrollWiring.test.ts, which guards the identical bug
 * class for ConversationThread -- keyed by conversationId for exactly this
 * reason), so this follows that file's established convention: a
 * structural source-text assertion that the remount boundary exists,
 * rather than a behavioral render test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

const conversationsPagePath = join(
  webRoot,
  "app/dashboard/conversations/[conversationId]/page.tsx",
);
const handoverPagePath = join(webRoot, "app/dashboard/handover/[conversationId]/page.tsx");
const draivaPagePath = join(webRoot, "app/dashboard/draiva/[conversationId]/page.tsx");
const composerPath = join(webRoot, "app/dashboard/ConversationComposerWithAssistant.tsx");
const replyComposerPath = join(
  webRoot,
  "app/dashboard/handover/[conversationId]/ReplyComposer.tsx",
);
const chatAgentPanelPath = join(webRoot, "app/dashboard/ChatAgentPanel.tsx");

describe("ConversationComposerWithAssistant remount-by-conversationId wiring", () => {
  it("Live Conversations detail page keys ConversationComposerWithAssistant by conversationId", () => {
    const source = readFileSync(conversationsPagePath, "utf8");
    const match = source.match(/<ConversationComposerWithAssistant\s+key=\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("conversationId");
  });

  it("Human Handover detail page keys ConversationComposerWithAssistant by conversationId (shared component, same fix)", () => {
    const source = readFileSync(handoverPagePath, "utf8");
    const match = source.match(/<ConversationComposerWithAssistant\s+key=\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("conversationId");
  });

  it("neither call site renders ConversationComposerWithAssistant without a key", () => {
    for (const path of [conversationsPagePath, handoverPagePath]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/<ConversationComposerWithAssistant\s+conversationId=/);
    }
  });

  it("DRAIVA's page already isolates conversation-switch state via a keyed provider wrapping its composer + assistant column (regression guard, not part of this fix)", () => {
    const source = readFileSync(draivaPagePath, "utf8");
    const match = source.match(/<DraivaDraftProvider\s+key=\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("conversationId");
    // Both DraivaReplyComposerSlot and DraivaAssistantColumn must render
    // inside that keyed element, not after its closing tag, or a remount
    // would silently stop covering one of them.
    const providerOpenIndex = source.indexOf("<DraivaDraftProvider");
    const providerCloseIndex = source.indexOf("</DraivaDraftProvider>");
    const composerSlotIndex = source.indexOf("<DraivaReplyComposerSlot");
    const assistantColumnIndex = source.indexOf("<DraivaAssistantColumn");
    expect(providerOpenIndex).toBeGreaterThan(-1);
    expect(providerCloseIndex).toBeGreaterThan(providerOpenIndex);
    expect(composerSlotIndex).toBeGreaterThan(providerOpenIndex);
    expect(composerSlotIndex).toBeLessThan(providerCloseIndex);
    expect(assistantColumnIndex).toBeGreaterThan(providerOpenIndex);
    expect(assistantColumnIndex).toBeLessThan(providerCloseIndex);
  });

  it("all conversation-scoped composer state stays inside the keyed subtree, not hoisted to an unkeyed ancestor", () => {
    // ReplyComposer: the fields that a stale remount would otherwise leak
    // across a conversation switch (service-window state and the unsent
    // draft's idempotency keys/errors).
    const replyComposerSource = readFileSync(replyComposerPath, "utf8");
    for (const field of [
      "windowClosed",
      "canSendReengagementTemplate",
      "templateSent",
      "templateError",
      "idempotencyKey",
    ]) {
      expect(replyComposerSource).toMatch(
        new RegExp(`\\[\\s*${field}\\s*,[^\\]]*\\]\\s*=\\s*useState`),
      );
    }

    // ChatAgentPanel: rendered as a child of ConversationComposerWithAssistant
    // (so it sits inside the same key boundary) -- confirm it isn't imported
    // by either page.tsx directly, which would put it outside that boundary.
    const chatAgentPanelSource = readFileSync(chatAgentPanelPath, "utf8");
    expect(chatAgentPanelSource).toMatch(/useState/);
    const composerSource = readFileSync(composerPath, "utf8");
    expect(composerSource).toMatch(/<ChatAgentPanel\b/);
    for (const path of [conversationsPagePath, handoverPagePath]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/ChatAgentPanel/);
    }
  });
});
