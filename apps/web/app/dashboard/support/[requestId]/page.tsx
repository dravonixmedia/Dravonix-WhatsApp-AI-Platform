import { notFound } from "next/navigation";
import { replySupportRequestAction } from "../../../../lib/actions/supportRequests.js";
import { formatDateTime } from "../../../../lib/formatDateTime.js";
import { getDashboardCapabilities } from "../../../../lib/permissions.js";
import { RealtimeRefreshBoundary } from "../../../../lib/realtime/RealtimeRefreshBoundary.js";
import { SUPPORT_REQUEST_DETAIL_WATCHES } from "../../../../lib/realtime/watchConfigs.js";
import { getCompanyTimezone } from "../../../../lib/repositories/companyTimezone.js";
import {
  getSupportRequest,
  SUPPORT_REQUEST_TYPE_LABELS,
} from "../../../../lib/repositories/supportRequestsRepository.js";
import { getDashboardSession } from "../../../../lib/session.js";
import { createServerSupabaseClient } from "../../../../lib/supabase/server.js";
import { SupportRequestStatusBadge } from "../../badges.js";

/** No display-name resolution exists for an arbitrary company member id from the client side -- masks the same way leads/[leadId]/page.tsx already masks assignedMemberId. */
function submittedByLabel(createdByUserId: string | null, ownUserId: string): string {
  if (!createdByUserId) return "Unknown";
  if (createdByUserId === ownUserId) return "You";
  return `Member ••${createdByUserId.slice(-4)}`;
}

export default async function SupportRequestDetailPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canViewSupportRequests) {
    return (
      <div className="dvx-card" style={{ maxWidth: 480 }}>
        <p className="dvx-muted" style={{ margin: 0 }}>
          Your role does not have permission to use Support &amp; Requests.
        </p>
      </div>
    );
  }

  const supabase = await createServerSupabaseClient();
  const [request, companyTimezone] = await Promise.all([
    getSupportRequest(supabase, session.activeCompanyId, requestId),
    getCompanyTimezone(supabase, session.activeCompanyId),
  ]);
  if (!request) notFound();

  return (
    <div>
      <RealtimeRefreshBoundary
        namespace="support-request-detail"
        scopeId={requestId}
        accessToken={session.accessToken}
        watches={SUPPORT_REQUEST_DETAIL_WATCHES}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: "1.3rem", margin: 0 }}>{request.reference}</h1>
          <div
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.3rem" }}
          >
            <SupportRequestStatusBadge status={request.status} />
            <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              {SUPPORT_REQUEST_TYPE_LABELS[request.type]}
            </span>
          </div>
        </div>
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "0.4rem" }}>
          {request.subject}
        </div>
        <p className="dvx-muted" style={{ fontSize: "0.78rem", marginBottom: "0.75rem" }}>
          Submitted by {submittedByLabel(request.createdByUserId, session.userId)} ·{" "}
          {formatDateTime(request.createdAt, companyTimezone)}
        </p>
        <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{request.description}</p>
      </div>

      <h2
        className="dvx-muted"
        style={{ fontSize: "0.85rem", textTransform: "uppercase", marginTop: "1.5rem" }}
      >
        Conversation
      </h2>

      {request.messages.length === 0 ? (
        <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
          No replies yet.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {request.messages.map((message) => (
            <div key={message.id} className="dvx-card" style={{ fontSize: "0.85rem" }}>
              <div className="dvx-muted" style={{ fontSize: "0.72rem", marginBottom: "0.3rem" }}>
                {message.authorType === "client" ? "You" : "Dravonix Support"} ·{" "}
                {formatDateTime(message.createdAt, companyTimezone)}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{message.message}</div>
            </div>
          ))}
        </div>
      )}

      {request.status !== "closed" ? (
        <form
          action={async (formData) => {
            "use server";
            await replySupportRequestAction(requestId, formData);
          }}
          className="dvx-card"
          style={{ marginTop: "1rem" }}
        >
          <label className="dvx-muted" style={{ fontSize: "0.8rem" }}>
            Add a reply
          </label>
          <textarea
            name="message"
            className="dvx-input"
            required
            maxLength={5000}
            rows={3}
            style={{ marginTop: "0.4rem", resize: "vertical" }}
          />
          <button
            className="dvx-button"
            type="submit"
            style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}
          >
            Send reply
          </button>
        </form>
      ) : (
        <p className="dvx-muted" style={{ fontSize: "0.85rem", marginTop: "1rem" }}>
          This request is closed.
        </p>
      )}
    </div>
  );
}
