import { notFound } from "next/navigation";
import {
  adminAssignSupportRequestAction,
  adminReopenSupportRequestAction,
  adminReplySupportRequestAction,
  adminResolveSupportRequestAction,
  adminUpdateSupportRequestPriorityAction,
  adminUpdateSupportRequestStatusAction,
} from "../../../../lib/actions/adminSupport.js";
import { formatDateTime } from "../../../../lib/formatDateTime.js";
import { getCompanyTimezone } from "../../../../lib/repositories/companyTimezone.js";
import {
  getAdminSupportRequest,
  listActivePlatformStaff,
  SUPPORT_REQUEST_PRIORITY_LABELS,
  SUPPORT_REQUEST_STATUS_LABELS,
  SUPPORT_REQUEST_TYPE_LABELS,
  type SupportRequestPriority,
  type SupportRequestStatus,
} from "../../../../lib/repositories/supportRequestsRepository.js";
import { createServerSupabaseClient } from "../../../../lib/supabase/server.js";
import {
  SupportRequestPriorityBadge,
  SupportRequestStatusBadge,
} from "../../../dashboard/badges.js";

/** platform_members has no display-name column (confirmed by audit) -- same masked-id precedent as support_access_sessions' own UI. */
function maskUserId(userId: string): string {
  return `User ••${userId.slice(-4)}`;
}

const NON_TERMINAL_STATUSES: SupportRequestStatus[] = [
  "open",
  "in_progress",
  "waiting_on_client",
  "closed",
];

function ActionButton({ children }: { children: React.ReactNode }) {
  return (
    <button className="dvx-button" type="submit" style={{ fontSize: "0.8rem" }}>
      {children}
    </button>
  );
}

export default async function AdminSupportRequestDetailPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  const supabase = await createServerSupabaseClient();
  const [request, staff] = await Promise.all([
    getAdminSupportRequest(supabase, requestId),
    listActivePlatformStaff(supabase),
  ]);
  if (!request) notFound();

  // The company *being administered* -- never Dravonix Media's own timezone,
  // regardless of which platform staff member is viewing this page.
  const companyTimezone = request.companyId
    ? await getCompanyTimezone(supabase, request.companyId)
    : null;

  const isTerminal = request.status === "resolved" || request.status === "closed";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: "1.3rem", margin: 0 }}>{request.reference}</h1>
          <div
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.3rem" }}
          >
            <SupportRequestStatusBadge status={request.status} />
            <SupportRequestPriorityBadge priority={request.priority} />
            <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              {SUPPORT_REQUEST_TYPE_LABELS[request.type]}
            </span>
          </div>
        </div>
      </div>

      <div className="dvx-card-grid dvx-card-grid--narrow" style={{ marginTop: "1.5rem" }}>
        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.6rem" }}>
            Request
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            <div className="dvx-muted" style={{ fontSize: "0.75rem" }}>
              Company
            </div>
            <div>{request.companyName ?? "Unknown (company deleted)"}</div>
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            <div className="dvx-muted" style={{ fontSize: "0.75rem" }}>
              Submitted by
            </div>
            <div>{request.createdByUserId ? maskUserId(request.createdByUserId) : "Unknown"}</div>
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            <div className="dvx-muted" style={{ fontSize: "0.75rem" }}>
              Created
            </div>
            <div>{formatDateTime(request.createdAt, companyTimezone)}</div>
          </div>
          <div>
            <div className="dvx-muted" style={{ fontSize: "0.75rem" }}>
              Assigned to
            </div>
            <div>
              {request.assignedPlatformUserId
                ? maskUserId(request.assignedPlatformUserId)
                : "Unassigned"}
            </div>
          </div>
        </div>

        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.6rem" }}>Manage</div>
          <form
            action={async (formData) => {
              "use server";
              await adminUpdateSupportRequestStatusAction(
                requestId,
                String(formData.get("status")) as SupportRequestStatus,
              );
            }}
            style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.6rem" }}
          >
            <select
              name="status"
              defaultValue={request.status}
              className="dvx-input"
              disabled={isTerminal}
            >
              {NON_TERMINAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {SUPPORT_REQUEST_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <ActionButton>Update</ActionButton>
          </form>

          <form
            action={async (formData) => {
              "use server";
              await adminUpdateSupportRequestPriorityAction(
                requestId,
                String(formData.get("priority")) as SupportRequestPriority,
              );
            }}
            style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.6rem" }}
          >
            <select name="priority" defaultValue={request.priority} className="dvx-input">
              {(Object.keys(SUPPORT_REQUEST_PRIORITY_LABELS) as SupportRequestPriority[]).map(
                (p) => (
                  <option key={p} value={p}>
                    {SUPPORT_REQUEST_PRIORITY_LABELS[p]}
                  </option>
                ),
              )}
            </select>
            <ActionButton>Set priority</ActionButton>
          </form>

          {staff.length > 0 ? (
            <form
              action={async (formData) => {
                "use server";
                const value = String(formData.get("platformUserId"));
                await adminAssignSupportRequestAction(requestId, value === "" ? null : value);
              }}
              style={{
                display: "flex",
                gap: "0.4rem",
                alignItems: "center",
                marginBottom: "0.6rem",
              }}
            >
              <select
                name="platformUserId"
                defaultValue={request.assignedPlatformUserId ?? ""}
                className="dvx-input"
              >
                <option value="">Unassigned</option>
                {staff.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {maskUserId(member.userId)} ({member.role})
                  </option>
                ))}
              </select>
              <ActionButton>Assign</ActionButton>
            </form>
          ) : null}

          <div style={{ display: "flex", gap: "0.4rem" }}>
            {!isTerminal ? (
              <form
                action={async () => {
                  "use server";
                  await adminResolveSupportRequestAction(requestId);
                }}
              >
                <ActionButton>Resolve</ActionButton>
              </form>
            ) : (
              <form
                action={async () => {
                  "use server";
                  await adminReopenSupportRequestAction(requestId);
                }}
              >
                <ActionButton>Reopen</ActionButton>
              </form>
            )}
          </div>
        </div>
      </div>

      <div className="dvx-card" style={{ marginTop: "1rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "0.4rem" }}>
          {request.subject}
        </div>
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
          No messages yet.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {request.messages.map((message) => (
            <div
              key={message.id}
              className="dvx-card"
              style={{
                fontSize: "0.85rem",
                borderLeft: message.isInternal ? "3px solid var(--warning, #d97706)" : undefined,
              }}
            >
              <div className="dvx-muted" style={{ fontSize: "0.72rem", marginBottom: "0.3rem" }}>
                {message.authorType === "client" ? "Client" : "Dravonix Support"}
                {message.isInternal ? " · Internal note" : ""} ·{" "}
                {formatDateTime(message.createdAt, companyTimezone)}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{message.message}</div>
            </div>
          ))}
        </div>
      )}

      <form
        action={async (formData) => {
          "use server";
          await adminReplySupportRequestAction(requestId, formData);
        }}
        className="dvx-card"
        style={{ marginTop: "1rem" }}
      >
        <label className="dvx-muted" style={{ fontSize: "0.8rem" }}>
          Reply
        </label>
        <textarea
          name="message"
          className="dvx-input"
          required
          maxLength={5000}
          rows={3}
          style={{ marginTop: "0.4rem", resize: "vertical" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginTop: "0.5rem" }}>
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.8rem" }}
          >
            <input type="checkbox" name="is_internal" />
            Internal note (never visible or emailed to the client)
          </label>
        </div>
        <button
          className="dvx-button"
          type="submit"
          style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
