import type {
  HandoverInboxFilterKind,
  HandoverInboxItem,
  HandoverInboxSort,
} from "@dravonix/handover";
import Link from "next/link";
import {
  assignToMeAction,
  assignToTeamMemberAction,
  markAsQueuedAction,
  startHumanConversationAction,
} from "../../../lib/actions/handover.js";
import { Avatar } from "../Avatar.js";
import { AiModeBadge, ConversationStateBadge } from "../badges.js";
import { EmptyState } from "../EmptyState.js";
import { HandoverIcon } from "../Icons.js";

const FILTERS: Array<{ key: HandoverInboxFilterKind; label: string }> = [
  { key: "unassigned", label: "Unassigned" },
  { key: "assigned_to_me", label: "Mine" },
  { key: "all_active", label: "All active" },
  { key: "closed", label: "Closed" },
];

function ActionButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      className="dvx-button"
      type="submit"
      style={{ fontSize: "0.7rem", padding: "0.25rem 0.5rem" }}
    >
      {children}
    </button>
  );
}

function waitingTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function HandoverQueuePanel({
  items,
  filter,
  sort,
  activeConversationId,
  callerMemberId,
  members,
}: {
  items: HandoverInboxItem[];
  filter: HandoverInboxFilterKind;
  sort: HandoverInboxSort;
  activeConversationId: string | null;
  callerMemberId: string;
  members: Array<{ id: string; role: string }> | null;
}) {
  return (
    <div className="dvx-card dvx-workspace-list" style={{ padding: 0 }}>
      <div
        className="dvx-panel-header"
        style={{ flexDirection: "column", alignItems: "stretch", gap: "0.6rem" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>Human Handover</span>
          <span className="dvx-muted" style={{ fontSize: "0.75rem" }}>
            {items.length}
          </span>
        </div>
        <div className="dvx-filter-tabs">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={`/dashboard/handover?filter=${f.key}&sort=${sort}`}
              className={`dvx-filter-pill${filter === f.key ? " dvx-filter-pill--active" : ""}`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="dvx-workspace-list-scroll" style={{ padding: "0.5rem" }}>
        {items.length === 0 ? (
          <EmptyState
            icon={<HandoverIcon size={28} />}
            title="No conversations match this filter"
            description="Try a different filter above."
          />
        ) : (
          items.map((item) => {
            const canAssignToMe =
              (item.state === "handover_requested" || item.state === "queued_for_agent") &&
              !item.assignedMemberId;
            const canAssignToTeam = item.state === "handover_requested" && !item.assignedMemberId;
            const canMarkQueued = item.state === "handover_requested";
            const canStart =
              (item.state === "queued_for_agent" || item.state === "handover_requested") &&
              item.assignedMemberId;

            return (
              <div
                key={item.conversationId}
                className={`dvx-conv-row${item.conversationId === activeConversationId ? " dvx-conv-row--selected" : ""}`}
              >
                <Link
                  href={`/dashboard/handover/${item.conversationId}?filter=${filter}&sort=${sort}`}
                  style={{ display: "block", color: "inherit", textDecoration: "none" }}
                >
                  <div style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start" }}>
                    <Avatar label={item.maskedPhoneNumber} size={34} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}
                      >
                        <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                          {item.maskedPhoneNumber}
                        </span>
                        <span className="dvx-muted" style={{ fontSize: "0.7rem", flexShrink: 0 }}>
                          waiting {waitingTime(item.waitingSince)}
                        </span>
                      </div>
                      {item.handoverReason ? (
                        <p
                          className="dvx-muted"
                          style={{
                            fontSize: "0.78rem",
                            margin: "0.15rem 0 0.4rem",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.handoverReason}
                        </p>
                      ) : (
                        <div style={{ height: "0.4rem" }} />
                      )}
                      <div
                        style={{
                          display: "flex",
                          gap: "0.3rem",
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <ConversationStateBadge state={item.state} />
                        <AiModeBadge aiMode={item.aiMode} />
                        {item.unreadCount > 0 ? (
                          <span className="dvx-badge dvx-badge--danger">
                            {item.unreadCount} unread
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </Link>

                {canAssignToMe || canAssignToTeam || canMarkQueued || canStart ? (
                  <div
                    style={{
                      display: "flex",
                      gap: "0.3rem",
                      flexWrap: "wrap",
                      marginTop: "0.5rem",
                    }}
                  >
                    {canAssignToMe ? (
                      <form
                        action={async () => {
                          "use server";
                          await assignToMeAction(item.conversationId);
                        }}
                      >
                        <ActionButton>Assign to me</ActionButton>
                      </form>
                    ) : null}
                    {canAssignToTeam && members && members.length > 0 ? (
                      <form
                        action={async (formData) => {
                          "use server";
                          await assignToTeamMemberAction(
                            item.conversationId,
                            String(formData.get("targetMemberId")),
                          );
                        }}
                        style={{ display: "flex", gap: "0.25rem" }}
                      >
                        <select
                          name="targetMemberId"
                          className="dvx-input"
                          style={{ fontSize: "0.7rem", padding: "0.2rem 0.4rem" }}
                        >
                          {members
                            .filter((m) => m.id !== callerMemberId)
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.role} ({m.id.slice(0, 6)})
                              </option>
                            ))}
                        </select>
                        <ActionButton>Assign</ActionButton>
                      </form>
                    ) : null}
                    {canMarkQueued ? (
                      <form
                        action={async () => {
                          "use server";
                          await markAsQueuedAction(item.conversationId);
                        }}
                      >
                        <ActionButton>Mark queued</ActionButton>
                      </form>
                    ) : null}
                    {canStart ? (
                      <form
                        action={async () => {
                          "use server";
                          await startHumanConversationAction(item.conversationId);
                        }}
                      >
                        <ActionButton>Start</ActionButton>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
