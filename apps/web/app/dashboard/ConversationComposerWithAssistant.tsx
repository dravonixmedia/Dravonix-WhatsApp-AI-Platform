"use client";

import { useState } from "react";
import { ReplyComposer } from "./handover/[conversationId]/ReplyComposer.js";
import { ChatAgentPanel } from "./ChatAgentPanel.js";
import { SparkleIcon } from "./Icons.js";

/**
 * Shared by Live Conversations and Human Handover (both already reuse the
 * same ReplyComposer -- see conversations/[conversationId]/page.tsx's own
 * comment on this). Owns the composer's draft text so the AI Assistant
 * panel can insert a generated reply into it via "Use in reply" -- it only
 * ever calls setDraft, never sendHumanReplyAction; sending still requires
 * the existing manual Send button inside ReplyComposer.
 */
export function ConversationComposerWithAssistant({ conversationId }: { conversationId: string }) {
  const [draft, setDraft] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          className="dvx-button dvx-button--secondary"
          style={{
            fontSize: "0.78rem",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
          }}
          onClick={() => setAssistantOpen((v) => !v)}
          aria-expanded={assistantOpen}
        >
          <SparkleIcon size={14} />
          AI Assistant
        </button>
      </div>

      <ReplyComposer conversationId={conversationId} value={draft} onChange={setDraft} />

      {assistantOpen ? (
        <>
          <div
            className="dvx-assistant-scrim"
            onClick={() => setAssistantOpen(false)}
            aria-hidden="true"
          />
          <ChatAgentPanel
            conversationId={conversationId}
            open={assistantOpen}
            onClose={() => setAssistantOpen(false)}
            currentDraft={draft}
            onUseReply={setDraft}
          />
        </>
      ) : null}
    </div>
  );
}
