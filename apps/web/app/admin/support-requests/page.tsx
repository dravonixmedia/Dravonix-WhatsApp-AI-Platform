import Link from "next/link";
import {
  listAdminSupportRequests,
  SUPPORT_REQUEST_PRIORITY_LABELS,
  SUPPORT_REQUEST_STATUS_LABELS,
  SUPPORT_REQUEST_TYPE_LABELS,
  type SupportRequestPriority,
  type SupportRequestStatus,
  type SupportRequestType,
} from "../../../lib/repositories/supportRequestsRepository.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { SupportRequestPriorityBadge, SupportRequestStatusBadge } from "../../dashboard/badges.js";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STATUS_FILTERS: Array<{ key: SupportRequestStatus | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "open", label: SUPPORT_REQUEST_STATUS_LABELS.open },
  { key: "in_progress", label: SUPPORT_REQUEST_STATUS_LABELS.in_progress },
  { key: "waiting_on_client", label: SUPPORT_REQUEST_STATUS_LABELS.waiting_on_client },
  { key: "resolved", label: SUPPORT_REQUEST_STATUS_LABELS.resolved },
  { key: "closed", label: SUPPORT_REQUEST_STATUS_LABELS.closed },
];

const TYPE_FILTERS: Array<{ key: SupportRequestType | "all"; label: string }> = [
  { key: "all", label: "All types" },
  ...(Object.keys(SUPPORT_REQUEST_TYPE_LABELS) as SupportRequestType[]).map((type) => ({
    key: type,
    label: SUPPORT_REQUEST_TYPE_LABELS[type],
  })),
];

const PRIORITY_FILTERS: Array<{ key: SupportRequestPriority | "all"; label: string }> = [
  { key: "all", label: "All priorities" },
  ...(Object.keys(SUPPORT_REQUEST_PRIORITY_LABELS) as SupportRequestPriority[]).map((priority) => ({
    key: priority,
    label: SUPPORT_REQUEST_PRIORITY_LABELS[priority],
  })),
];

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function AdminSupportRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    type?: string;
    priority?: string;
    companyId?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const status = (params.status as SupportRequestStatus | "all" | undefined) ?? "all";
  const type = (params.type as SupportRequestType | "all" | undefined) ?? "all";
  const priority = (params.priority as SupportRequestPriority | "all" | undefined) ?? "all";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const supabase = await createServerSupabaseClient();
  const { items, totalCount } = await listAdminSupportRequests(supabase, {
    status,
    type,
    priority,
    companyId: params.companyId,
    page,
    pageSize: PAGE_SIZE,
  });

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const baseQuery = (overrides: Record<string, string>) => {
    const q = new URLSearchParams({
      status,
      type,
      priority,
      ...(params.companyId ? { companyId: params.companyId } : {}),
      ...overrides,
    });
    return `/admin/support-requests?${q.toString()}`;
  };

  return (
    <div>
      <h1 className="dvx-page-title">Support &amp; Requests</h1>
      <p className="dvx-muted">
        Every client-submitted support request across every company. {totalCount} total.
        {params.companyId ? (
          <>
            {" "}
            Filtered to one company —{" "}
            <Link href="/admin/support-requests" className="dvx-muted">
              clear
            </Link>
            .
          </>
        ) : null}
      </p>

      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", margin: "1rem 0" }}>
        <div className="dvx-filter-tabs">
          {STATUS_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={baseQuery({ status: f.key })}
              className={`dvx-filter-pill${status === f.key ? " dvx-filter-pill--active" : ""}`}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div className="dvx-filter-tabs">
          {TYPE_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={baseQuery({ type: f.key })}
              className={`dvx-filter-pill${type === f.key ? " dvx-filter-pill--active" : ""}`}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div className="dvx-filter-tabs">
          {PRIORITY_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={baseQuery({ priority: f.key })}
              className={`dvx-filter-pill${priority === f.key ? " dvx-filter-pill--active" : ""}`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="dvx-card">
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No support requests match these filters.
          </p>
        </div>
      ) : (
        <div className="dvx-card" style={{ padding: 0 }}>
          <div className="dvx-team-member-list">
            {items.map((item) => (
              <Link
                key={item.id}
                href={`/admin/support-requests/${item.id}`}
                className="dvx-team-member-row"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <span className="dvx-team-member-name">
                  {item.reference}
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    {item.companyName ?? "Unknown company"} ·{" "}
                    {SUPPORT_REQUEST_TYPE_LABELS[item.type]} · {item.subject}
                  </span>
                </span>
                <span
                  style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexShrink: 0 }}
                >
                  <span className="dvx-muted" style={{ fontSize: "0.75rem" }}>
                    {relativeTime(item.lastRepliedAt ?? item.updatedAt)}
                  </span>
                  <SupportRequestPriorityBadge priority={item.priority} />
                  <SupportRequestStatusBadge status={item.status} />
                </span>
              </Link>
            ))}
          </div>
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
