import {
  listHandoverInbox,
  SupabaseHandoverRepository,
  type HandoverInboxFilterKind,
  type HandoverInboxSort,
} from "@dravonix/handover";
import Link from "next/link";
import {
  assignToMeAction,
  assignToTeamMemberAction,
  endHumanAssistanceAction,
  markAsQueuedAction,
  pauseAiAction,
  resumeAiAction,
  startHumanConversationAction,
} from "../../../lib/actions/handover.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

const FILTERS: Array<{ key: HandoverInboxFilterKind; label: string }> = [
  { key: "unassigned", label: "Unassigned" },
  { key: "assigned_to_me", label: "Assigned to me" },
  { key: "all_active", label: "All active handovers" },
  { key: "closed", label: "Closed" },
];

function ActionButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      className="dvx-button"
      type="submit"
      style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
    >
      {children}
    </button>
  );
}

export default async function HandoverInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; sort?: string }>;
}) {
  const params = await searchParams;
  const filter = (params.filter as HandoverInboxFilterKind | undefined) ?? "all_active";
  const sort = (params.sort as HandoverInboxSort | undefined) ?? "newest_first";

  const session = await getDashboardSession();
  if (!session) return null;

  const supabase = await createServerSupabaseClient();
  const repo = new SupabaseHandoverRepository(supabase);

  const items = await listHandoverInbox(repo, {
    companyId: session.activeCompanyId,
    filter,
    sort,
    callerMemberId: session.activeMemberId,
  });

  const { data: members } = await supabase
    .from("company_members")
    .select("id, role")
    .eq("company_id", session.activeCompanyId)
    .eq("is_active", true);

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem" }}>Human Handover Inbox</h1>
      <p className="dvx-muted">
        Conversations that requested, are queued for, or are actively receiving human assistance.
        The AI keeps replying by default even after a human is assigned -- use Pause AI to stop it
        explicitly.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", margin: "1rem 0" }}>
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/dashboard/handover?filter=${f.key}&sort=${sort}`}
            className="dvx-button"
            style={{
              fontSize: "0.8rem",
              opacity: filter === f.key ? 1 : 0.6,
              textDecoration: "none",
            }}
          >
            {f.label}
          </Link>
        ))}
        <Link
          href={`/dashboard/handover?filter=${filter}&sort=${sort === "newest_first" ? "oldest_first" : "newest_first"}`}
          className="dvx-button"
          style={{ fontSize: "0.8rem", marginLeft: "auto", textDecoration: "none" }}
        >
          {sort === "newest_first" ? "Newest first" : "Oldest first"}
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="dvx-card">
          <p className="dvx-muted" style={{ margin: 0 }}>
            No conversations match this filter.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {items.map((item) => (
            <div key={item.conversationId} className="dvx-card">
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}
              >
                <Link
                  href={`/dashboard/handover/${item.conversationId}`}
                  style={{ fontWeight: 600 }}
                >
                  {item.maskedPhoneNumber}
                </Link>
                <span className="dvx-muted" style={{ fontSize: "0.75rem" }}>
                  {item.state} · priority: {item.priority} · unread: {item.unreadCount} · ai_mode:{" "}
                  {item.aiMode}
                </span>
              </div>
              {item.handoverReason ? (
                <p className="dvx-muted" style={{ fontSize: "0.85rem", margin: "0.35rem 0" }}>
                  {item.handoverReason}
                </p>
              ) : null}

              <div
                style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem" }}
              >
                {(item.state === "handover_requested" || item.state === "queued_for_agent") &&
                !item.assignedMemberId ? (
                  <form
                    action={async () => {
                      "use server";
                      await assignToMeAction(item.conversationId);
                    }}
                  >
                    <ActionButton>Assign to me</ActionButton>
                  </form>
                ) : null}

                {item.state === "handover_requested" && !item.assignedMemberId ? (
                  <form
                    action={async (formData) => {
                      "use server";
                      await assignToTeamMemberAction(
                        item.conversationId,
                        String(formData.get("targetMemberId")),
                      );
                    }}
                    style={{ display: "flex", gap: "0.3rem" }}
                  >
                    <select
                      name="targetMemberId"
                      className="dvx-input"
                      style={{ fontSize: "0.75rem" }}
                    >
                      {(members ?? [])
                        .filter((m) => m.id !== session.activeMemberId)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.role} ({m.id.slice(0, 8)})
                          </option>
                        ))}
                    </select>
                    <ActionButton>Assign to teammate</ActionButton>
                  </form>
                ) : null}

                {item.state === "handover_requested" ? (
                  <form
                    action={async () => {
                      "use server";
                      await markAsQueuedAction(item.conversationId);
                    }}
                  >
                    <ActionButton>Mark as queued</ActionButton>
                  </form>
                ) : null}

                {(item.state === "queued_for_agent" || item.state === "handover_requested") &&
                item.assignedMemberId ? (
                  <form
                    action={async () => {
                      "use server";
                      await startHumanConversationAction(item.conversationId);
                    }}
                  >
                    <ActionButton>Start human conversation</ActionButton>
                  </form>
                ) : null}

                {item.aiMode === "active" ? (
                  <form
                    action={async () => {
                      "use server";
                      await pauseAiAction(item.conversationId);
                    }}
                  >
                    <ActionButton>Pause AI</ActionButton>
                  </form>
                ) : (
                  <form
                    action={async () => {
                      "use server";
                      await resumeAiAction(item.conversationId);
                    }}
                  >
                    <ActionButton>Resume AI</ActionButton>
                  </form>
                )}

                {item.state !== "closed" && item.state !== "ai_active" ? (
                  <form
                    action={async () => {
                      "use server";
                      await endHumanAssistanceAction(item.conversationId);
                    }}
                  >
                    <ActionButton>End human assistance</ActionButton>
                  </form>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
