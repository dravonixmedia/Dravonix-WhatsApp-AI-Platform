import Link from "next/link";
import { platformBrand } from "@dravonix/config";
import { getDashboardSession } from "../../lib/session.js";
import { createServerSupabaseClient } from "../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

interface OverviewCounts {
  activeConversations: number;
  handoverRequests: number;
  aiPaused: number;
  unassignedHandovers: number;
  recentLeads: number | null;
}

async function loadOverviewCounts(companyId: string): Promise<OverviewCounts> {
  const supabase = await createServerSupabaseClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Every query below is a tenant-scoped COUNT (head: true -- no rows
  // transferred), never a full-row fetch; RLS additionally enforces the
  // company_id scoping server-side regardless of this filter.
  const [active, handovers, paused, unassigned, leads] = await Promise.all([
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
      .eq("ai_mode", "paused"),
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("state", "handover_requested")
      .is("assigned_member_id", null),
    // leads.view is enforced by RLS -- a role without it gets a
    // permission-denied error here, treated as "omit this metric" rather
    // than surfacing a raw database error on the Overview page.
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .gte("created_at", sevenDaysAgo),
  ]);

  return {
    activeConversations: active.count ?? 0,
    handoverRequests: handovers.count ?? 0,
    aiPaused: paused.count ?? 0,
    unassignedHandovers: unassigned.count ?? 0,
    recentLeads: leads.error ? null : (leads.count ?? 0),
  };
}

export default async function DashboardOverviewPage() {
  const session = await getDashboardSession();
  if (!session) return null; // middleware.ts already guarantees this can't happen for /dashboard/*

  const counts = await loadOverviewCounts(session.activeCompanyId);
  const activeCompanyName =
    session.memberships.find((m) => m.companyId === session.activeCompanyId)?.companyName ?? "";

  const statCards: { label: string; value: number; href: string }[] = [
    {
      label: "Active conversations",
      value: counts.activeConversations,
      href: "/dashboard/conversations",
    },
    { label: "Handover requests", value: counts.handoverRequests, href: "/dashboard/handover" },
    {
      label: "AI-paused conversations",
      value: counts.aiPaused,
      href: "/dashboard/conversations?aiMode=paused",
    },
    {
      label: "Unassigned handovers",
      value: counts.unassignedHandovers,
      href: "/dashboard/handover?filter=unassigned",
    },
  ];
  if (counts.recentLeads !== null) {
    statCards.push({
      label: "New leads (7d)",
      value: counts.recentLeads,
      href: "/dashboard/leads",
    });
  }

  const needsAttention =
    counts.handoverRequests > 0 || counts.aiPaused > 0 || counts.unassignedHandovers > 0;

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "0.25rem" }}>Overview</h1>
      <p className="dvx-text-secondary" style={{ marginTop: 0 }}>
        {platformBrand.productName} — {activeCompanyName}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          marginTop: "1.5rem",
        }}
      >
        {statCards.map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className="dvx-card dvx-card--interactive"
            style={{ display: "block", textDecoration: "none", color: "inherit" }}
          >
            <div className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              {card.label}
            </div>
            <div style={{ fontSize: "1.8rem", fontWeight: 700, marginTop: "0.25rem" }}>
              {card.value}
            </div>
          </Link>
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
            {counts.handoverRequests > 0
              ? `${counts.handoverRequests} conversation(s) requesting human handover. `
              : ""}
            {counts.aiPaused > 0 ? `${counts.aiPaused} conversation(s) with AI paused. ` : ""}
            <Link href="/dashboard/handover">Open Human Handover Inbox →</Link>
          </p>
        </div>
      )}
    </div>
  );
}
