import Link from "next/link";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { RealtimeRefreshBoundary } from "../../../lib/realtime/RealtimeRefreshBoundary.js";
import {
  listLeads,
  type LeadListAssignmentFilter,
  type LeadListStageFilter,
} from "../../../lib/repositories/leadsRepository.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STAGE_FILTERS: Array<{ key: LeadListStageFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "qualifying", label: "Qualifying" },
  { key: "qualified", label: "Qualified" },
  { key: "proposal_sent", label: "Proposal sent" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
];

const ASSIGNMENT_FILTERS: Array<{ key: LeadListAssignmentFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "mine", label: "Assigned to me" },
  { key: "unassigned", label: "Unassigned" },
];

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

function PermissionDenied() {
  return (
    <div className="dvx-card" style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Leads</h1>
      <p className="dvx-muted" style={{ margin: 0 }}>
        Your role does not have permission to view leads.
      </p>
    </div>
  );
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string;
    stage?: string;
    assignment?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canViewLeads) return <PermissionDenied />;

  const stage = (params.stage as LeadListStageFilter | undefined) ?? "all";
  const assignment = (params.assignment as LeadListAssignmentFilter | undefined) ?? "all";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();
  const { items, totalCount } = await listLeads(supabase, {
    companyId: session.activeCompanyId,
    callerMemberId: session.activeMemberId,
    search: params.search,
    stage,
    assignment,
    page,
    pageSize: PAGE_SIZE,
  });

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const baseQuery = (overrides: Record<string, string>) => {
    const q = new URLSearchParams({
      ...(params.search ? { search: params.search } : {}),
      stage,
      assignment,
      ...overrides,
    });
    return `/dashboard/leads?${q.toString()}`;
  };

  return (
    <div>
      <RealtimeRefreshBoundary
        namespace="leads-list"
        scopeId={session.activeCompanyId}
        accessToken={session.accessToken}
        watches={[{ table: "leads", filterColumn: "company_id" }]}
      />
      <h1 style={{ fontSize: "1.4rem" }}>Leads</h1>
      <p className="dvx-muted">
        Leads collected by the AI chatbot (customer name, service interest, budget, timeline, etc.)
        across every conversation for this company.
      </p>

      <form
        method="GET"
        style={{ display: "flex", gap: "0.5rem", margin: "1rem 0", flexWrap: "wrap" }}
      >
        <input type="hidden" name="stage" value={stage} />
        <input type="hidden" name="assignment" value={assignment} />
        <input
          className="dvx-input"
          type="search"
          name="search"
          placeholder="Search by name, company, phone, or email"
          defaultValue={params.search}
          style={{ maxWidth: 320 }}
        />
        <button className="dvx-button dvx-button--secondary" type="submit">
          Search
        </button>
      </form>

      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {STAGE_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={baseQuery({ stage: f.key })}
              className="dvx-badge"
              style={{
                textDecoration: "none",
                background: stage === f.key ? "var(--surface-selected)" : "var(--surface-hover)",
                color: stage === f.key ? "var(--brand-cyan)" : "var(--text-secondary)",
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
      </div>

      {items.length === 0 ? (
        <div className="dvx-card">
          <p className="dvx-muted" style={{ margin: 0 }}>
            No leads match these filters.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {items.map((item) => (
            <Link
              key={item.id}
              href={`/dashboard/leads/${item.id}`}
              className="dvx-card dvx-card--interactive"
              style={{ display: "block", textDecoration: "none", color: "inherit" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>
                    {item.customerName ?? item.maskedPhoneNumber ?? "Unknown lead"}
                  </span>
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
                    {[item.companyName, item.serviceInterest].filter(Boolean).join(" — ") ||
                      "No details yet"}
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
                    {relativeTime(item.updatedAt)}
                  </span>
                  <span className="dvx-badge dvx-badge--neutral">
                    {item.stage.replace(/_/g, " ")}
                  </span>
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
