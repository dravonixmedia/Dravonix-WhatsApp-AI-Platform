"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ConversationListItem } from "../../../lib/repositories/conversationsRepository.js";
import { Avatar } from "../Avatar.js";
import { AiModeBadge } from "../badges.js";
import { ChatAgentPanel } from "../ChatAgentPanel.js";
import { EmptyState } from "../EmptyState.js";
import { ConversationsIcon, MicIcon, SparkleIcon } from "../Icons.js";

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function messagePreview(item: ConversationListItem): string {
  if (item.latestMessageChannelType === "audio") {
    return item.latestMessagePreview ?? "Voice message";
  }
  return item.latestMessagePreview ?? "No messages yet";
}

/**
 * Dedicated DRAIVA workspace (/dashboard/draiva) -- a new UI entry point
 * into the exact same Chat Agent logic the conversation-detail composer
 * already uses (ChatAgentPanel, chatAgentAction, chatAgentContext). This
 * component only ever selects which already-existing conversationId
 * ChatAgentPanel renders for; it never re-implements a prompt, provider
 * call, action definition, or result parser of its own.
 *
 * Selecting a conversation stores its id in local state -- switching that
 * id is exactly what already resets ChatAgentPanel's own internal state
 * (its `useEffect(() => {...}, [conversationId])` cleanup), so no
 * additional "clear previous result" logic is needed here.
 */
export function DraivaWorkspace({ conversations }: { conversations: ConversationListItem[] }) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copyHint, setCopyHint] = useState(false);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter((item) => {
      const name = (item.displayName ?? item.maskedPhoneNumber).toLowerCase();
      return name.includes(term) || item.maskedPhoneNumber.toLowerCase().includes(term);
    });
  }, [conversations, search]);

  const selected = conversations.find((item) => item.conversationId === selectedId) ?? null;

  function selectConversation(conversationId: string) {
    setSelectedId(conversationId);
    setCopyHint(false);
  }

  // Preferred safe behaviour (this workspace has no reply composer of its
  // own to fill, and no safe way exists to prefill a *different* route's
  // composer from here without inventing a fragile cross-route draft
  // mechanism -- see the "Open conversation" link below instead): copy the
  // result so nothing generated is ever silently lost, matching the
  // panel's own always-available "Copy" action.
  function handleUseInReply(text: string) {
    void navigator.clipboard.writeText(text);
    setCopyHint(true);
  }

  return (
    <div className="dvx-workspace">
      <div className="dvx-card dvx-workspace-list" style={{ padding: 0 }}>
        <div
          className="dvx-panel-header"
          style={{ flexDirection: "column", alignItems: "stretch", gap: "0.6rem" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>Conversations</span>
            <span className="dvx-muted" style={{ fontSize: "0.75rem" }}>
              {conversations.length}
            </span>
          </div>
          <input
            className="dvx-input"
            type="search"
            placeholder="Search name or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search conversations"
            style={{ fontSize: "0.82rem" }}
          />
          {selected ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                fontSize: "0.78rem",
              }}
            >
              <span className="dvx-muted">
                {copyHint
                  ? "Copied — open the conversation to paste it into the reply box."
                  : "Working with:"}
              </span>
              {!copyHint ? (
                <span style={{ fontWeight: 600 }}>
                  {selected.displayName ?? selected.maskedPhoneNumber}
                </span>
              ) : null}
              <Link
                href={`/dashboard/conversations/${selected.conversationId}`}
                className="dvx-button dvx-button--secondary"
                style={{ fontSize: "0.72rem", marginLeft: "auto" }}
              >
                Open conversation
              </Link>
            </div>
          ) : null}
        </div>

        <div className="dvx-workspace-list-scroll" style={{ padding: "0.5rem" }}>
          {filtered.length === 0 ? (
            <EmptyState
              icon={<ConversationsIcon size={28} />}
              title="No conversations found"
              description="Try a different search term."
            />
          ) : (
            filtered.map((item) => (
              <button
                key={item.conversationId}
                type="button"
                onClick={() => selectConversation(item.conversationId)}
                aria-pressed={item.conversationId === selectedId}
                className={`dvx-conv-row dvx-conv-row-button${
                  item.conversationId === selectedId ? " dvx-conv-row--selected" : ""
                }`}
              >
                <div style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start" }}>
                  <Avatar label={item.displayName ?? item.maskedPhoneNumber} size={34} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}
                    >
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: "0.87rem",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.displayName ?? item.maskedPhoneNumber}
                      </span>
                      <span className="dvx-muted" style={{ fontSize: "0.7rem", flexShrink: 0 }}>
                        {relativeTime(item.lastMessageAt)}
                      </span>
                    </div>
                    <p
                      className="dvx-muted"
                      style={{
                        fontSize: "0.78rem",
                        margin: "0.15rem 0 0.4rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.25rem",
                      }}
                    >
                      {item.latestMessageChannelType === "audio" ? <MicIcon size={12} /> : null}
                      {messagePreview(item)}
                    </p>
                    <div style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                      <AiModeBadge aiMode={item.aiMode} />
                      {item.state === "handover_requested" || item.state === "queued_for_agent" ? (
                        <span className="dvx-badge dvx-badge--info">Handover</span>
                      ) : null}
                      {item.hasUnreadActivity ? (
                        <span
                          aria-label="Unread activity"
                          title="Unread activity"
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: "var(--brand-cyan)",
                            marginLeft: "auto",
                          }}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className={`dvx-workspace-detail${selected ? " dvx-workspace-detail--active" : ""}`}>
        {selected ? (
          <ChatAgentPanel
            conversationId={selected.conversationId}
            open={true}
            onClose={() => setSelectedId(null)}
            currentDraft=""
            onUseReply={handleUseInReply}
          />
        ) : (
          <div className="dvx-workspace-center">
            <EmptyState
              icon={<SparkleIcon size={36} />}
              title="Select a conversation"
              description="Choose a conversation from the list to let DRAIVA review its context."
            />
          </div>
        )}
      </div>
    </div>
  );
}
