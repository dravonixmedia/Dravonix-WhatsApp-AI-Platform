import Link from "next/link";
import { listConversations } from "../../lib/repositories/conversationsRepository.js";
import { listLeads } from "../../lib/repositories/leadsRepository.js";
import { loadNotificationSummary } from "../../lib/repositories/notificationsRepository.js";
import { getDashboardSession } from "../../lib/session.js";
import { createServerSupabaseClient } from "../../lib/supabase/server.js";
import { BrandIcon } from "../BrandLogo.js";
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
      <section className="dvx-hero">
        <BrandIcon size={140} className="dvx-hero-icon" />
        <span className="dvx-hero-eyebrow">Welcome back</span>
        <h1 className="dvx-hero-heading">Welcome, {activeCompanyName} 👋</h1>
        <p className="dvx-hero-subtitle">
          Here&apos;s what&apos;s happening with your WhatsApp AI Platform today.
        </p>
      </section>

      <div className="dvx-kpi-grid" style={{ marginTop: "1.5rem" }}>
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </div>

      {!needsAttention ? (
        <div className="dvx-card dvx-attention-card" style={{ marginTop: "1.5rem" }}>
          <span className="dvx-attention-icon" aria-hidden="true">
            <HandoverIcon size={18} />
          </span>
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>All clear</div>
            <p className="dvx-muted" style={{ fontSize: "0.82rem", margin: "0.15rem 0 0" }}>
              No conversations currently need attention.
            </p>
          </div>
        </div>
      ) : (
        <div
          className="dvx-card dvx-attention-card dvx-attention-card--warning"
          style={{ marginTop: "1.5rem" }}
        >
          <span className="dvx-attention-icon" aria-hidden="true">
            <HandoverIcon size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>Needs attention</div>
            <p className="dvx-muted" style={{ fontSize: "0.82rem", margin: "0.15rem 0 0" }}>
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
            </p>
          </div>
          <Link href="/dashboard/handover" className="dvx-button dvx-button--secondary">
            Open inbox →
          </Link>
        </div>
      )}

      <div className="dvx-analytics-grid" style={{ marginTop: "1.5rem" }}>
        <div className="dvx-card">
          <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Conversations overview</span>
          <div style={{ marginTop: "0.5rem" }}>
            <div className="dvx-summary-row">
              <span className="dvx-summary-label">Active conversations</span>
              <span className="dvx-summary-value">{counts.activeConversations}</span>
            </div>
            <div className="dvx-summary-row">
              <span className="dvx-summary-label">Currently with a human</span>
              <span className="dvx-summary-value">{counts.activeHumanAssistance}</span>
            </div>
            <div className="dvx-summary-row">
              <span className="dvx-summary-label">Awaiting a human</span>
              <span className="dvx-summary-value">{counts.pendingHandoverRequests}</span>
            </div>
          </div>
          <p className="dvx-summary-note">
            Live snapshot of current conversation state. Trend history will appear here once
            historical tracking is available.
          </p>
        </div>

        <div className="dvx-card">
          <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>AI activity</span>
          <div style={{ marginTop: "0.5rem" }}>
            <div className="dvx-summary-row">
              <span className="dvx-summary-label">AI-paused conversations</span>
              <span className="dvx-summary-value">{counts.aiPaused}</span>
            </div>
            <div className="dvx-summary-row">
              <span className="dvx-summary-label">Unread customer messages</span>
              <span className="dvx-summary-value">{counts.unreadCustomerMessages}</span>
            </div>
            <div className="dvx-summary-row">
              <span className="dvx-summary-label">New leads (7d)</span>
              <span className="dvx-summary-value">{counts.recentLeads ?? "—"}</span>
            </div>
          </div>
          <p className="dvx-summary-note">
            Live snapshot of current AI state. Resolution-rate and response-time analytics will
            appear here once historical tracking is available.
          </p>
        </div>
      </div>

      <div className="dvx-card-grid" style={{ marginTop: "1.5rem" }}>
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
