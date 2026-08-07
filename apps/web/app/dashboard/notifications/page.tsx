import Link from "next/link";
import { handoverItemNeedsAttention, SupabaseHandoverRepository } from "@dravonix/handover";
import { markConversationReadAction } from "../../../lib/actions/handover.js";
import { loadNotificationSummary } from "../../../lib/repositories/notificationsRepository.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { EmptyState } from "../EmptyState.js";
import { BellIcon, ConversationsIcon, HandoverIcon } from "../Icons.js";

export const dynamic = "force-dynamic";

type NotificationsFilter = "all" | "unread" | "conversations" | "handover";

const FILTERS: Array<{ key: NotificationsFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "conversations", label: "Conversations" },
  { key: "handover", label: "Human Handover" },
];

interface NotificationRow {
  key: string;
  category: "conversation" | "handover";
  conversationId: string;
  title: string;
  preview: string;
  time: string | null;
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function handoverPreview(item: {
  state: string;
  assignedMemberId: string | null;
  unreadCount: number;
}): string {
  if (item.assignedMemberId === null) return "No team member assigned yet";
  if (item.state === "handover_requested" || item.state === "queued_for_agent") {
    return "Awaiting a human response";
  }
  if (item.unreadCount > 0) {
    return `${item.unreadCount} unread message${item.unreadCount === 1 ? "" : "s"}`;
  }
  return "Needs attention";
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const params = await searchParams;
  const filter: NotificationsFilter = FILTERS.some((f) => f.key === params.filter)
    ? (params.filter as NotificationsFilter)
    : "all";

  const session = await getDashboardSession();
  if (!session) return null;

  const supabase = await createServerSupabaseClient();
  const handoverRepo = new SupabaseHandoverRepository(supabase);

  // Reuses the exact same two data sources DashboardLayout already loads for
  // the top-right bell and the Human Handover nav badge (loadNotificationSummary,
  // listHandoverInbox + handoverItemNeedsAttention) -- this page is a second
  // *view* onto that one notification state, never a second notification
  // system, so its counts can never drift from the bell's. Realtime updates
  // come from the same dashboard-shell RealtimeRefreshBoundary already
  // mounted in layout.tsx (its watches already cover conversations/messages/
  // conversation_assignments/handover_events company-wide), so no second
  // boundary or polling is added here.
  const [notificationSummary, handoverInboxItems] = await Promise.all([
    loadNotificationSummary(supabase, session.activeCompanyId),
    handoverRepo.listHandoverInbox({
      companyId: session.activeCompanyId,
      filter: "all_active",
      sort: "newest_first",
    }),
  ]);

  const handoverItems = handoverInboxItems.filter(handoverItemNeedsAttention);

  const conversationRows: NotificationRow[] = notificationSummary.unreadConversations.map(
    (item) => ({
      key: `conversation-${item.conversationId}`,
      category: "conversation",
      conversationId: item.conversationId,
      title: item.displayName,
      preview: `${item.unreadCount} unread message${item.unreadCount === 1 ? "" : "s"}`,
      time: null,
    }),
  );

  const handoverRows: NotificationRow[] = handoverItems.map((item) => ({
    key: `handover-${item.conversationId}`,
    category: "handover",
    conversationId: item.conversationId,
    title: item.maskedPhoneNumber,
    preview: handoverPreview(item),
    time: item.waitingSince,
  }));

  // "Unread" and "All" show the same rows: nothing in this notification
  // model carries a separate persisted read/unread flag beyond the two
  // real signals already computed above (unread customer messages,
  // handover items needing attention) -- every row shown here already IS
  // one of those two things, so there is no third "already read but still
  // listed" category to distinguish. Kept as two tabs anyway to match the
  // approved filter design; not a bug.
  const allRows = [...handoverRows, ...conversationRows];
  const rows =
    filter === "conversations" ? conversationRows : filter === "handover" ? handoverRows : allRows;

  return (
    <div className="dvx-page-fill">
      <h1 style={{ fontSize: "1.4rem" }}>Notifications</h1>
      <p className="dvx-muted">
        Stay on top of customer messages, handovers and activity that needs your attention.
      </p>

      <div className="dvx-filter-tabs" style={{ marginTop: "1rem" }}>
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={
              f.key === "all"
                ? "/dashboard/notifications"
                : `/dashboard/notifications?filter=${f.key}`
            }
            className={`dvx-filter-pill${filter === f.key ? " dvx-filter-pill--active" : ""}`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <div
        className="dvx-card"
        style={{
          marginTop: "1rem",
          padding: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: "1.5rem" }}>
            <EmptyState
              icon={<BellIcon size={28} />}
              title="You're all caught up"
              description="Nothing needs your attention right now."
            />
          </div>
        ) : (
          rows.map((row) => {
            const relative = relativeTime(row.time);
            const detailHref =
              row.category === "handover"
                ? `/dashboard/handover/${row.conversationId}`
                : `/dashboard/conversations/${row.conversationId}`;
            return (
              <div
                key={row.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "0.6rem 0.75rem",
                  padding: "0.85rem 1.1rem",
                  borderBottom: "1px solid var(--border-default)",
                }}
              >
                <span
                  className="dvx-kpi-icon"
                  style={{
                    background:
                      row.category === "handover" ? "var(--info-surface)" : "var(--surface-hover)",
                    color: row.category === "handover" ? "var(--info)" : "var(--text-secondary)",
                    flexShrink: 0,
                  }}
                  aria-hidden="true"
                >
                  {row.category === "handover" ? (
                    <HandoverIcon size={18} />
                  ) : (
                    <ConversationsIcon size={18} />
                  )}
                </span>

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                    <span style={{ fontWeight: 600, fontSize: "0.87rem" }}>{row.title}</span>
                    {relative ? (
                      <span className="dvx-muted" style={{ fontSize: "0.72rem", flexShrink: 0 }}>
                        {relative}
                      </span>
                    ) : null}
                  </div>
                  <p className="dvx-muted" style={{ fontSize: "0.8rem", margin: "0.15rem 0 0" }}>
                    {row.preview}
                  </p>
                </div>

                <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
                  <Link
                    href={detailHref}
                    className="dvx-button dvx-button--secondary"
                    style={{ fontSize: "0.75rem" }}
                  >
                    {row.category === "handover" ? "Open Human Handover" : "Open conversation"}
                  </Link>
                  <form
                    action={async () => {
                      "use server";
                      await markConversationReadAction(row.conversationId);
                    }}
                  >
                    <button
                      type="submit"
                      className="dvx-button dvx-button--secondary"
                      style={{ fontSize: "0.75rem" }}
                    >
                      Mark as read
                    </button>
                  </form>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
