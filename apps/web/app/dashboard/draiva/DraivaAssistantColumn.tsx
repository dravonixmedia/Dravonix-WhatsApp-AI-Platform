"use client";

import { useState } from "react";
import { ChatAgentPanel } from "../ChatAgentPanel.js";
import { SparkleIcon } from "../Icons.js";
import { useDraivaDraft } from "./DraivaDraftContext.js";

/**
 * DRAIVA's right column. On desktop (see the `.dvx-draiva-assistant-wrap`
 * CSS in globals.css) this renders ChatAgentPanel as an always-visible
 * third column instead of its usual fixed-position drawer -- the override
 * is scoped to this wrapper class only, so ChatAgentPanel itself and every
 * other page using it (ConversationComposerWithAssistant) are untouched.
 * Below the tablet breakpoint the exact same fixed-drawer/bottom-sheet +
 * scrim overlay ChatAgentPanel already ships with is reused unchanged,
 * just opened from this column's own toggle button instead of one next to
 * the reply composer.
 *
 * ChatAgentPanel is always mounted with open=true; on mobile, visibility is
 * driven by the wrap/--open CSS classes below rather than by unmounting
 * the panel, so a mobile show/hide toggle never disturbs its own
 * conversationId-keyed internal reset effect.
 */
export function DraivaAssistantColumn({ conversationId }: { conversationId: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { draft, setDraft } = useDraivaDraft();

  return (
    <div
      className={`dvx-draiva-assistant-wrap${mobileOpen ? " dvx-draiva-assistant-wrap--open" : ""}`}
    >
      <button
        type="button"
        className="dvx-button dvx-button--secondary dvx-draiva-assistant-toggle"
        onClick={() => setMobileOpen(true)}
        aria-expanded={mobileOpen}
        aria-label="Open DRAIVA conversation assistant"
      >
        <SparkleIcon size={14} /> Ask DRAIVA
      </button>
      {mobileOpen ? (
        <div
          className="dvx-assistant-scrim"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      <ChatAgentPanel
        conversationId={conversationId}
        open={true}
        onClose={() => setMobileOpen(false)}
        currentDraft={draft}
        onUseReply={setDraft}
      />
    </div>
  );
}
