import Link from "next/link";
import type {
  ConversationListAiModeFilter,
  ConversationListAssignmentFilter,
} from "../../../lib/repositories/conversationsRepository.js";
import { AiModeBadge } from "../badges.js";
import { EmptyState } from "../EmptyState.js";
import { ConversationsIcon, MicIcon } from "../Icons.js";
import { Avatar } from "../Avatar.js";
import type { ConversationsListData } from "./conversationsListData.js";

const AI_MODE_FILTERS: Array<{ key: ConversationListAiModeFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "AI Active" },
  { key: "paused", label: "AI Paused" },
];

const ASSIGNMENT_FILTERS: Array<{ key: ConversationListAssignmentFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "mine", label: "Mine" },
  { key: "unassigned", label: "Unassigned" },
];

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

function messagePreview(item: ConversationsListData["page"]["items"][number]): string {
  if (item.latestMessageChannelType === "audio") {
    return item.latestMessagePreview ?? "Voice message";
  }
  return item.latestMessagePreview ?? "No messages yet";
}

export function ConversationListPanel({
  data,
  activeConversationId,
}: {
  data: ConversationsListData;
  activeConversationId: string | null;
}) {
  const { page, search, aiMode, assignment, handover, pageNumber, totalPages } = data;

  const baseQuery = (overrides: Record<string, string>) => {
    const q = new URLSearchParams({
      ...(search ? { search } : {}),
      aiMode,
      assignment,
      handover,
      ...overrides,
    });
    return `/dashboard/conversations?${q.toString()}`;
  };

  return (
    <div className="dvx-card dvx-workspace-list" style={{ padding: 0 }}>
      <div
        className="dvx-panel-header"
        style={{ flexDirection: "column", alignItems: "stretch", gap: "0.6rem" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>Live Conversations</span>
          <span className="dvx-muted" style={{ fontSize: "0.75rem" }}>
            {page.totalCount}
          </span>
        </div>
        <form
          method="GET"
          action="/dashboard/conversations"
          style={{ display: "flex", gap: "0.4rem" }}
        >
          <input type="hidden" name="aiMode" value={aiMode} />
          <input type="hidden" name="assignment" value={assignment} />
          <input type="hidden" name="handover" value={handover} />
          <input
            className="dvx-input"
            type="search"
            name="search"
            placeholder="Search name or phone"
            defaultValue={search}
            style={{ fontSize: "0.82rem" }}
          />
        </form>
        <div className="dvx-filter-tabs">
          {AI_MODE_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={baseQuery({ aiMode: f.key })}
              className={`dvx-filter-pill${aiMode === f.key ? " dvx-filter-pill--active" : ""}`}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div className="dvx-filter-tabs">
          {ASSIGNMENT_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={baseQuery({ assignment: f.key })}
              className={`dvx-filter-pill${assignment === f.key ? " dvx-filter-pill--active" : ""}`}
            >
              {f.label}
            </Link>
          ))}
          <Link
            href={baseQuery({ handover: handover === "requested" ? "all" : "requested" })}
            className={`dvx-filter-pill${handover === "requested" ? " dvx-filter-pill--active" : ""}`}
          >
            Handover
          </Link>
        </div>
      </div>

      <div className="dvx-workspace-list-scroll" style={{ padding: "0.5rem" }}>
        {page.items.length === 0 ? (
          <EmptyState
            icon={<ConversationsIcon size={28} />}
            title="No conversations found"
            description="Try a different search term or filter."
          />
        ) : (
          page.items.map((item) => (
            <Link
              key={item.conversationId}
              href={`/dashboard/conversations/${item.conversationId}?${new URLSearchParams({
                ...(search ? { search } : {}),
                aiMode,
                assignment,
                handover,
              }).toString()}`}
              className={`dvx-conv-row${item.conversationId === activeConversationId ? " dvx-conv-row--selected" : ""}`}
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

      {totalPages > 1 ? (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            justifyContent: "center",
            padding: "0.6rem",
            borderTop: "1px solid var(--border-default)",
          }}
        >
          {pageNumber > 1 ? (
            <Link
              href={baseQuery({ page: String(pageNumber - 1) })}
              className="dvx-button dvx-button--secondary"
              style={{ fontSize: "0.75rem" }}
            >
              Prev
            </Link>
          ) : null}
          <span className="dvx-muted" style={{ alignSelf: "center", fontSize: "0.78rem" }}>
            {pageNumber} / {totalPages}
          </span>
          {pageNumber < totalPages ? (
            <Link
              href={baseQuery({ page: String(pageNumber + 1) })}
              className="dvx-button dvx-button--secondary"
              style={{ fontSize: "0.75rem" }}
            >
              Next
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
