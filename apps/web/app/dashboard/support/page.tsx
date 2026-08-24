import Link from "next/link";
import { createSupportRequestAction } from "../../../lib/actions/supportRequests.js";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { RealtimeRefreshBoundary } from "../../../lib/realtime/RealtimeRefreshBoundary.js";
import { SUPPORT_REQUESTS_LIST_WATCHES } from "../../../lib/realtime/watchConfigs.js";
import {
  CLIENT_SELECTABLE_PRIORITIES,
  listSupportRequests,
  SUPPORT_REQUEST_PRIORITY_LABELS,
  SUPPORT_REQUEST_TYPE_LABELS,
  type SupportRequestType,
} from "../../../lib/repositories/supportRequestsRepository.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { SupportRequestStatusBadge } from "../badges.js";
import { EmptyState } from "../EmptyState.js";
import { SettingsIcon } from "../Icons.js";

export const dynamic = "force-dynamic";

const REQUEST_TYPES = Object.keys(SUPPORT_REQUEST_TYPE_LABELS) as SupportRequestType[];

function relativeTime(iso: string): string {
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
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Support &amp; Requests</h1>
      <p className="dvx-muted" style={{ margin: 0 }}>
        Your role does not have permission to use Support &amp; Requests.
      </p>
    </div>
  );
}

export default async function SupportRequestsPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canViewSupportRequests) return <PermissionDenied />;

  const supabase = await createServerSupabaseClient();
  const items = await listSupportRequests(supabase, session.activeCompanyId);

  return (
    <div>
      <RealtimeRefreshBoundary
        namespace="support-requests-list"
        scopeId={session.activeCompanyId}
        accessToken={session.accessToken}
        watches={SUPPORT_REQUESTS_LIST_WATCHES}
      />
      <h1 className="dvx-page-title">Support &amp; Requests</h1>
      <p className="dvx-muted">
        Submit a complaint, service request, technical issue, feature request, or general support
        request to Dravonix, and track its status here.
      </p>

      <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Submit a request
        </div>
        <form
          action={createSupportRequestAction}
          style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
        >
          <div>
            <label className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              Request type
            </label>
            <select name="type" className="dvx-input" required defaultValue="general_support">
              {REQUEST_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SUPPORT_REQUEST_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              Subject
            </label>
            <input
              name="subject"
              className="dvx-input"
              required
              maxLength={200}
              placeholder="Short summary of your request"
            />
          </div>
          <div>
            <label className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              Description
            </label>
            <textarea
              name="description"
              className="dvx-input"
              required
              maxLength={5000}
              rows={4}
              style={{ resize: "vertical" }}
              placeholder="Describe your request in detail"
            />
          </div>
          <div>
            <label className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              Priority (optional)
            </label>
            <select name="priority" className="dvx-input" defaultValue="normal">
              {CLIENT_SELECTABLE_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {SUPPORT_REQUEST_PRIORITY_LABELS[priority]}
                </option>
              ))}
            </select>
          </div>
          <button className="dvx-button" type="submit" style={{ alignSelf: "flex-start" }}>
            Submit request
          </button>
        </form>
      </div>

      <h2
        className="dvx-muted"
        style={{ fontSize: "0.85rem", textTransform: "uppercase", marginTop: "2rem" }}
      >
        Your requests
      </h2>

      {items.length === 0 ? (
        <div className="dvx-card">
          <EmptyState
            icon={<SettingsIcon size={32} />}
            title="No support requests yet"
            description="Submit a request above and it will appear here."
          />
        </div>
      ) : (
        <div className="dvx-card" style={{ padding: 0 }}>
          {items.map((item) => (
            <Link
              key={item.id}
              href={`/dashboard/support/${item.id}`}
              className="dvx-conv-row dvx-card--interactive"
              style={{ borderRadius: 0, borderBottom: "1px solid var(--border-default)" }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "1rem",
                  alignItems: "center",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{item.reference}</span>
                  <p
                    className="dvx-muted"
                    style={{
                      fontSize: "0.82rem",
                      margin: "0.2rem 0 0",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 420,
                    }}
                  >
                    {SUPPORT_REQUEST_TYPE_LABELS[item.type]} — {item.subject}
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
                    {relativeTime(item.lastRepliedAt ?? item.updatedAt)}
                  </span>
                  <SupportRequestStatusBadge status={item.status} />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
