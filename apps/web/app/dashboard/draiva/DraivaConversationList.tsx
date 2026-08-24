"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ConversationListItem } from "../../../lib/repositories/conversationsRepository.js";
import { Avatar } from "../Avatar.js";
import { AiModeBadge } from "../badges.js";
import { EmptyState } from "../EmptyState.js";
import { ConversationsIcon, MicIcon } from "../Icons.js";

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
 * The DRAIVA workspace's left column -- a lighter-weight "recent
 * conversations" selector (client-side instant filter, no server round
 * trip), not the full filtered/paginated search Live Conversations has.
 * Shared between /dashboard/draiva (no selection) and
 * /dashboard/draiva/[conversationId] (selected) so both routes render an
 * identical list; selecting a row is plain Next.js navigation to
 * /dashboard/draiva/{conversationId} rather than local state, which is
 * what makes the current conversation deep-linkable and refresh-safe.
 */
export function DraivaConversationList({
  conversations,
  activeConversationId,
}: {
  conversations: ConversationListItem[];
  activeConversationId: string | null;
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter((item) => {
      const name = (item.displayName ?? item.maskedPhoneNumber).toLowerCase();
      return name.includes(term) || item.maskedPhoneNumber.toLowerCase().includes(term);
    });
  }, [conversations, search]);

  return (
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
            <Link
              key={item.conversationId}
              href={`/dashboard/draiva/${item.conversationId}`}
              aria-current={item.conversationId === activeConversationId ? "true" : undefined}
              className={`dvx-conv-row${
                item.conversationId === activeConversationId ? " dvx-conv-row--selected" : ""
              }`}
            >
              <div style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start" }}>
                <Avatar label={item.displayName ?? item.maskedPhoneNumber} size={34} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
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
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
