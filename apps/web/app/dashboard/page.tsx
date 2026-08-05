import Link from "next/link";
import { platformBrand } from "@dravonix/config";
import { listConversations } from "../../lib/repositories/conversationsRepository.js";
import { listLeads } from "../../lib/repositories/leadsRepository.js";
import { loadNotificationSummary } from "../../lib/repositories/notificationsRepository.js";
import { getDashboardSession } from "../../lib/session.js";
import { createServerSupabaseClient } from "../../lib/supabase/server.js";
import { Avatar } from "./Avatar.js";
import { AiModeBadge, LeadStageBadge } from "./badges.js";
import { EmptyState } from "./EmptyState.js";
import { ConversationsIcon, HandoverIcon, LeadsIcon, PauseIcon, UserPlusIcon } from "./Icons.js";
import { KpiCard } from "./KpiCard.js";

export const dynamic = "force-dynamic";

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

interface OverviewCounts {
  activeConversations: number;
  /** Conversations currently awaiting a human response/assignment (handover_requested or queued_for_agent) -- NOT including conversations a human is already actively assisting (see activeHumanAssistance). */
  pendingHandoverRequests: number;
  /** Conversations currently in the human_active state -- a human is actively assisting right now. Kept as a distinct metric from pendingHandoverRequests so "still waiting" and "being worked on" are never conflated. */
  activeHumanAssistance: number;
  aiPaused: number;
  /** Pending or active handovers without a valid assignee, per the existing lifecycle contract (assigned_member_id is always set once a conversation reaches human_active, so in practice this only ever matches pending states). */
  unassignedHandovers: number;
  /**
   * Real unread INBOUND CUSTOMER MESSAGE total (not a conversation count --
   * see lib/repositories/notificationsRepository.ts's loadNotificationSummary,
   * the same function backing the notification bell badge) across every
   * open conversation in this company.
   */
  unreadCustomerMessages: number;
  recentLeads: number | null;
}

async function loadOverviewCounts(companyId: string): Promise<OverviewCounts> {
  const supabase = await createServerSupabaseClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Every conversations/leads query below is a tenant-scoped COUNT (head:
  // true -- no rows transferred), never a full-row fetch; RLS additionally
  // enforces the company_id scoping server-side regardless of this filter.
  // Each of the five conversation-state metrics below counts a disjoint
  // condition (pending vs. human_active vs. ai_paused vs. unassigned), so no
  // single conversation is ever double-counted within one metric.
  const [active, pending, activeHuman, paused, unassigned, leads, notificationSummary] =
    await Promise.all([
      supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .neq("state", "closed"),
      supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .in("state", ["handover_requested", "queued_for_agent"]),
      supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("state", "human_active"),
      supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("ai_mode", "paused"),
      supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .in("state", ["handover_requested", "queued_for_agent"])
        .is("assigned_member_id", null),
      // leads.view is enforced by RLS -- a role without it gets a
      // permission-denied error here, treated as "omit this metric" rather
      // than surfacing a raw database error on the Overview page.
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .gte("created_at", sevenDaysAgo),
      loadNotificationSummary(supabase, companyId),
    ]);

  return {
    activeConversations: active.count ?? 0,
    pendingHandoverRequests: pending.count ?? 0,
    activeHumanAssistance: activeHuman.count ?? 0,
    aiPaused: paused.count ?? 0,
    unassignedHandovers: unassigned.count ?? 0,
    unreadCustomerMessages: notificationSummary.totalUnreadCustomerMessages,
    recentLeads: leads.error ? null : (leads.count ?? 0),
  };
}

export default async function DashboardOverviewPage() {
  const session = await getDashboardSession();
  if (!session) return null; // middleware.ts already guarantees this can't happen for /dashboard/*

  const supabase = await createServerSupabaseClient();
  const [counts, recentConversations, recentLeads] = await Promise.all([
    loadOverviewCounts(session.activeCompanyId),
    listConversations(supabase, {
      companyId: session.activeCompanyId,
      callerMemberId: session.activeMemberId,
      page: 1,
      pageSize: 5,
    }),
    listLeads(supabase, {
      companyId: session.activeCompanyId,
      callerMemberId: session.activeMemberId,
      page: 1,
      pageSize: 5,
    }).catch(() => ({ items: [], totalCount: 0 })), // leads.view may be denied by RLS for this role
  ]);
  const activeCompanyName =
    session.memberships.find((m) => m.companyId === session.activeCompanyId)?.companyName ?? "";

  const kpis: Array<{
    label: string;
    value: number;
    href: string;
    icon: React.ReactNode;
    tone: "brand" | "warning" | "info" | "success";
  }> = [
    {
      label: "Active conversations",
      value: counts.activeConversations,
      href: "/dashboard/conversations",
      icon: <ConversationsIcon />,
      tone: "brand",
    },
    {
      label: "Pending handover requests",
      value: counts.pendingHandoverRequests,
      href: "/dashboard/handover",
      icon: <HandoverIcon />,
      tone: "info",
    },
    {
      label: "Active human assistance",
      value: counts.activeHumanAssistance,
      href: "/dashboard/handover",
      icon: <HandoverIcon />,
      tone: "brand",
    },
    {
      label: "Unassigned handovers",
      value: counts.unassignedHandovers,
      href: "/dashboard/handover?filter=unassigned",
      icon: <HandoverIcon />,
      tone: "warning",
    },
    {
      label: "Unread customer messages",
      value: counts.unreadCustomerMessages,
      href: "/dashboard/conversations",
      icon: <ConversationsIcon />,
      tone: "warning",
    },
    {
      label: "AI-paused conversations",
      value: counts.aiPaused,
      href: "/dashboard/conversations?aiMode=paused",
      icon: <PauseIcon />,
      tone: "warning",
    },
  ];
  if (counts.recentLeads !== null) {
    kpis.push({
      label: "New leads (7d)",
      value: counts.recentLeads,
      href: "/dashboard/leads",
      icon: <UserPlusIcon />,
      tone: "success",
    });
  }

  const needsAttention =
    counts.pendingHandoverRequests > 0 ||
    counts.aiPaused > 0 ||
    counts.unassignedHandovers > 0 ||
    counts.unreadCustomerMessages > 0;

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "0.25rem" }}>Overview</h1>
      <p className="dvx-text-secondary" style={{ marginTop: 0 }}>
        {platformBrand.productName} — {activeCompanyName}
      </p>

      <div className="dvx-kpi-grid" style={{ marginTop: "1.5rem" }}>
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </div>

      {!needsAttention ? (
        <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
          <span className="dvx-badge dvx-badge--success">All clear</span>
          <p className="dvx-muted" style={{ fontSize: "0.85rem", marginTop: "0.75rem" }}>
            No conversations currently need attention.
          </p>
        </div>
      ) : (
        <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
          <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Needs attention</div>
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            {counts.pendingHandoverRequests > 0
              ? `${counts.pendingHandoverRequests} conversation(s) awaiting a human response. `
              : ""}
            {counts.unassignedHandovers > 0
              ? `${counts.unassignedHandovers} handover(s) with no team member assigned. `
              : ""}
            {counts.unreadCustomerMessages > 0
              ? `${counts.unreadCustomerMessages} unread customer message(s). `
              : ""}
            {counts.aiPaused > 0 ? `${counts.aiPaused} conversation(s) with AI paused. ` : ""}
            <Link href="/dashboard/handover">Open Human Handover Inbox →</Link>
          </p>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "1rem",
          marginTop: "1.5rem",
        }}
      >
        <div className="dvx-card" style={{ padding: 0 }}>
          <div className="dvx-panel-header">
            <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Recent conversations</span>
            <Link
              href="/dashboard/conversations"
              className="dvx-muted"
              style={{ fontSize: "0.8rem" }}
            >
              View all →
            </Link>
          </div>
          {recentConversations.items.length === 0 ? (
            <EmptyState
              icon={<ConversationsIcon size={28} />}
              title="No conversations yet"
              description="Inbound WhatsApp conversations for this company will appear here."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {recentConversations.items.map((item) => (
                <Link
                  key={item.conversationId}
                  href={`/dashboard/conversations/${item.conversationId}`}
                  className="dvx-conv-row dvx-card--interactive"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.75rem",
                    borderBottom: "1px solid var(--border-default)",
                    borderRadius: 0,
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: "0.6rem", minWidth: 0 }}
                  >
                    <Avatar label={item.displayName ?? item.maskedPhoneNumber} size={30} />
                    <span
                      style={{
                        fontSize: "0.85rem",
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.displayName ?? item.maskedPhoneNumber}
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexShrink: 0 }}
                  >
                    <AiModeBadge aiMode={item.aiMode} />
                    <span className="dvx-muted" style={{ fontSize: "0.72rem" }}>
                      {relativeTime(item.lastMessageAt)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="dvx-card" style={{ padding: 0 }}>
          <div className="dvx-panel-header">
            <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Recent leads</span>
            <Link href="/dashboard/leads" className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              View all →
            </Link>
          </div>
          {recentLeads.items.length === 0 ? (
            <EmptyState
              icon={<LeadsIcon size={28} />}
              title="No leads yet"
              description="Leads captured by the AI chatbot will appear here."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {recentLeads.items.map((item) => (
                <Link
                  key={item.id}
                  href={`/dashboard/leads/${item.id}`}
                  className="dvx-conv-row dvx-card--interactive"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.75rem",
                    borderBottom: "1px solid var(--border-default)",
                    borderRadius: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: "0.85rem",
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.customerName ?? item.maskedPhoneNumber ?? "Unknown lead"}
                  </span>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexShrink: 0 }}
                  >
                    <LeadStageBadge stage={item.stage} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
