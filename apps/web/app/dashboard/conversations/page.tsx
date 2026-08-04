import Link from "next/link";
import {
  listConversations,
  type ConversationListAiModeFilter,
  type ConversationListAssignmentFilter,
  type ConversationListHandoverFilter,
} from "../../../lib/repositories/conversationsRepository.js";
import { RealtimeRefreshBoundary } from "../../../lib/realtime/RealtimeRefreshBoundary.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const AI_MODE_FILTERS: Array<{ key: ConversationListAiModeFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "AI Active" },
  { key: "paused", label: "AI Paused" },
];

const ASSIGNMENT_FILTERS: Array<{ key: ConversationListAssignmentFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "mine", label: "Assigned to me" },
  { key: "unassigned", label: "Unassigned" },
];

function channelIndicator(channelType: string | null): string {
  switch (channelType) {
    case "audio":
      return "🎤 Voice";
    case "template":
      return "Template";
    case "system":
      return "System";
    case "text":
      return "Text";
    default:
      return "";
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string;
    aiMode?: string;
    assignment?: string;
    handover?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const session = await getDashboardSession();
  if (!session) return null;

  const aiMode = (params.aiMode as ConversationListAiModeFilter | undefined) ?? "all";
  const assignment = (params.assignment as ConversationListAssignmentFilter | undefined) ?? "all";
  const handover = (params.handover as ConversationListHandoverFilter | undefined) ?? "all";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();
  const { items, totalCount } = await listConversations(supabase, {
    companyId: session.activeCompanyId,
    callerMemberId: session.activeMemberId,
    search: params.search,
    aiMode,
    assignment,
    handover,
    page,
    pageSize: PAGE_SIZE,
  });

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const baseQuery = (overrides: Record<string, string>) => {
    const q = new URLSearchParams({
      ...(params.search ? { search: params.search } : {}),
      aiMode,
      assignment,
      handover,
      ...overrides,
    });
    return `/dashboard/conversations?${q.toString()}`;
  };

  return (
    <div>
      <RealtimeRefreshBoundary
        namespace="conversations-list"
        scopeId={session.activeCompanyId}
        accessToken={session.accessToken}
        watches={[
          { table: "conversations", filterColumn: "company_id" },
          { table: "messages", filterColumn: "company_id" },
          { table: "conversation_assignments", filterColumn: "company_id" },
        ]}
      />
      <h1 style={{ fontSize: "1.4rem" }}>Live Conversations</h1>
      <p className="dvx-muted">All conversations for this company, across every channel.</p>

      <form
        method="GET"
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}
      >
        <input type="hidden" name="aiMode" value={aiMode} />
        <input type="hidden" name="assignment" value={assignment} />
        <input type="hidden" name="handover" value={handover} />
        <input
          className="dvx-input"
          type="search"
          name="search"
          placeholder="Search by name or phone number"
          defaultValue={params.search}
          style={{ maxWidth: 280 }}
        />
        <button className="dvx-button dvx-button--secondary" type="submit">
          Search
        </button>
      </form>

      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {AI_MODE_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={baseQuery({ aiMode: f.key })}
              className="dvx-badge"
              style={{
                textDecoration: "none",
                background: aiMode === f.key ? "var(--surface-selected)" : "var(--surface-hover)",
                color: aiMode === f.key ? "var(--brand-cyan)" : "var(--text-secondary)",
              }}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {ASSIGNMENT_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={baseQuery({ assignment: f.key })}
              className="dvx-badge"
              style={{
                textDecoration: "none",
                background:
                  assignment === f.key ? "var(--surface-selected)" : "var(--surface-hover)",
                color: assignment === f.key ? "var(--brand-cyan)" : "var(--text-secondary)",
              }}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <Link
          href={baseQuery({ handover: handover === "requested" ? "all" : "requested" })}
          className="dvx-badge"
          style={{
            textDecoration: "none",
            background: handover === "requested" ? "var(--info-surface)" : "var(--surface-hover)",
            color: handover === "requested" ? "var(--info)" : "var(--text-secondary)",
          }}
        >
          Handover requested only
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="dvx-card">
          <p className="dvx-muted" style={{ margin: 0 }}>
            No conversations match these filters.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {items.map((item) => (
            <Link
              key={item.conversationId}
              href={`/dashboard/conversations/${item.conversationId}`}
              className="dvx-card dvx-card--interactive"
              style={{ display: "block", textDecoration: "none", color: "inherit" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ fontWeight: 600 }}>
                      {item.displayName ?? item.maskedPhoneNumber}
                    </span>
                    {item.hasUnreadActivity ? (
                      <span
                        aria-label="Unread activity"
                        title="Unread activity"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "var(--brand-cyan)",
                          display: "inline-block",
                          flexShrink: 0,
                        }}
                      />
                    ) : null}
                  </div>
                  <p
                    className="dvx-muted"
                    style={{
                      fontSize: "0.85rem",
                      margin: "0.25rem 0 0",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 480,
                    }}
                  >
                    {item.latestMessageChannelType && item.latestMessageChannelType !== "text"
                      ? `${channelIndicator(item.latestMessageChannelType)} — `
                      : ""}
                    {item.latestMessagePreview ?? "No messages yet"}
                  </p>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: "0.3rem",
                    flexShrink: 0,
                  }}
                >
                  <span className="dvx-muted" style={{ fontSize: "0.75rem" }}>
                    {relativeTime(item.lastMessageAt)}
                  </span>
                  <div style={{ display: "flex", gap: "0.3rem" }}>
                    <span
                      className={`dvx-badge ${item.aiMode === "active" ? "dvx-badge--success" : "dvx-badge--warning"}`}
                    >
                      {item.aiMode === "active" ? "AI Active" : "AI Paused"}
                    </span>
                    {item.state === "handover_requested" || item.state === "queued_for_agent" ? (
                      <span className="dvx-badge dvx-badge--info">Handover</span>
                    ) : null}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div
          style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", justifyContent: "center" }}
        >
          {page > 1 ? (
            <Link
              href={baseQuery({ page: String(page - 1) })}
              className="dvx-button dvx-button--secondary"
            >
              Previous
            </Link>
          ) : null}
          <span className="dvx-muted" style={{ alignSelf: "center", fontSize: "0.85rem" }}>
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              href={baseQuery({ page: String(page + 1) })}
              className="dvx-button dvx-button--secondary"
            >
              Next
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
