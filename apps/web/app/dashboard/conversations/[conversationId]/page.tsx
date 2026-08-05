import { loadEnv } from "@dravonix/config";
import { AppError } from "@dravonix/core";
import {
  deriveAiLikelyProcessing,
  getConversationThreadForDashboard,
  markConversationRead,
  SupabaseHandoverRepository,
} from "@dravonix/handover";
import { createLogger } from "@dravonix/observability";
import { notFound } from "next/navigation";
import {
  assignToMeAction,
  assignToTeamMemberAction,
  endHumanAssistanceAction,
  pauseAiAction,
  resumeAiAction,
} from "../../../../lib/actions/handover.js";
import { getDashboardCapabilities } from "../../../../lib/permissions.js";
import { RealtimeRefreshBoundary } from "../../../../lib/realtime/RealtimeRefreshBoundary.js";
import { CONVERSATION_DETAIL_WATCHES } from "../../../../lib/realtime/watchConfigs.js";
import { getDashboardSession } from "../../../../lib/session.js";
import { createServerSupabaseClient } from "../../../../lib/supabase/server.js";
import { Avatar } from "../../Avatar.js";
import { AiModeBadge, ConversationStateBadge } from "../../badges.js";
import { WhatsAppIcon } from "../../Icons.js";
import { loadContactSummary } from "../../loadContactSummary.js";
// Reused directly from the Human Handover module: these components are
// conversation-generic (pagination, composer, reconciliation), not
// handover-specific, so Live Conversations shares them rather than
// duplicating pagination/composer/idempotency logic.
import { ConversationThread } from "../../handover/[conversationId]/ConversationThread.js";
import { ReplyComposer } from "../../handover/[conversationId]/ReplyComposer.js";
import { ConversationListPanel } from "../ConversationListPanel.js";
import {
  loadConversationsListData,
  type ConversationsListSearchParams,
} from "../conversationsListData.js";

function ActionButton({ children }: { children: React.ReactNode }) {
  return (
    <button className="dvx-button" type="submit" style={{ fontSize: "0.8rem" }}>
      {children}
    </button>
  );
}

export default async function ConversationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<ConversationsListSearchParams>;
}) {
  const { conversationId } = await params;
  const listParams = await searchParams;
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  const supabase = await createServerSupabaseClient();
  const repo = new SupabaseHandoverRepository(supabase);

  const listData = await loadConversationsListData(
    supabase,
    session.activeCompanyId,
    session.activeMemberId,
    listParams,
  );

  let conversation: Awaited<ReturnType<typeof getConversationThreadForDashboard>>["conversation"];
  let thread: Awaited<ReturnType<typeof getConversationThreadForDashboard>>["thread"];
  try {
    const result = await getConversationThreadForDashboard(
      repo,
      session.activeCompanyId,
      conversationId,
    );
    conversation = result.conversation;
    thread = result.thread;
  } catch (err) {
    // Never leak internal Supabase/Postgres error text, and never reveal
    // whether the conversation exists in another tenant.
    const env = loadEnv(process.env);
    createLogger({
      environment: env.APP_ENV,
      companyId: session.activeCompanyId,
      conversationId,
    }).warn("conversation_detail_unavailable", {
      errorCode: err instanceof AppError ? err.code : "unknown",
    });
    notFound();
  }

  await markConversationRead(repo, conversationId);
  const contact = await loadContactSummary(supabase, conversationId);

  const latestInbound = [...thread.messages].reverse().find((m) => m.direction === "inbound");
  const latestAiOutbound = [...thread.messages]
    .reverse()
    .find((m) => m.direction === "outbound" && m.senderType === "ai");
  const aiLikelyProcessing = deriveAiLikelyProcessing({
    aiMode: conversation.aiMode,
    latestInboundAt: latestInbound?.createdAt ?? null,
    latestAiOutboundAt: latestAiOutbound?.createdAt ?? null,
  });

  const { data: members } = capabilities.canAssignConversations
    ? await supabase
        .from("company_members")
        .select("id, role")
        .eq("company_id", session.activeCompanyId)
        .eq("is_active", true)
    : { data: null };

  const displayName = contact?.displayName ?? contact?.maskedPhoneNumber ?? "Customer";

  return (
    <div className="dvx-page-fill">
      <RealtimeRefreshBoundary
        namespace="conversation-detail"
        scopeId={conversationId}
        accessToken={session.accessToken}
        watches={CONVERSATION_DETAIL_WATCHES}
      />
      <div className="dvx-workspace">
        <ConversationListPanel data={listData} activeConversationId={conversationId} />

        <div className="dvx-workspace-detail dvx-workspace-detail--active">
          <div className="dvx-workspace-center">
            <div className="dvx-panel-header">
              <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", minWidth: 0 }}>
                <Avatar label={displayName} size={38} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>{displayName}</div>
                  <div
                    className="dvx-muted"
                    style={{
                      fontSize: "0.75rem",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.3rem",
                    }}
                  >
                    <WhatsAppIcon size={12} />
                    {contact?.maskedPhoneNumber ?? "Unknown number"}
                    {aiLikelyProcessing ? " · AI is likely drafting a reply" : ""}
                  </div>
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "0.4rem",
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                }}
              >
                {capabilities.canAssignConversations &&
                !conversation.assignedMemberId &&
                (conversation.state === "handover_requested" ||
                  conversation.state === "queued_for_agent") ? (
                  <form
                    action={async () => {
                      "use server";
                      await assignToMeAction(conversationId);
                    }}
                  >
                    <ActionButton>Assign to me</ActionButton>
                  </form>
                ) : null}

                {capabilities.canAssignConversations &&
                !conversation.assignedMemberId &&
                conversation.state === "handover_requested" &&
                members &&
                members.length > 0 ? (
                  <form
                    action={async (formData) => {
                      "use server";
                      await assignToTeamMemberAction(
                        conversationId,
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
                      {members
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

                {capabilities.canPauseResumeAi ? (
                  conversation.aiMode === "active" ? (
                    <form
                      action={async () => {
                        "use server";
                        await pauseAiAction(conversationId);
                      }}
                    >
                      <ActionButton>Pause AI</ActionButton>
                    </form>
                  ) : (
                    <form
                      action={async () => {
                        "use server";
                        await resumeAiAction(conversationId);
                      }}
                    >
                      <ActionButton>Resume AI</ActionButton>
                    </form>
                  )
                ) : null}

                {capabilities.canAssignConversations &&
                conversation.state !== "closed" &&
                conversation.state !== "ai_active" ? (
                  <form
                    action={async () => {
                      "use server";
                      await endHumanAssistanceAction(conversationId);
                    }}
                  >
                    <ActionButton>Resolve handover</ActionButton>
                  </form>
                ) : null}
              </div>
            </div>

            <ConversationThread
              key={session.activeCompanyId}
              conversationId={conversationId}
              initialMessages={thread.messages}
              initialHasMore={thread.hasMore}
              accessToken={session.accessToken}
            />

            <div
              style={{
                padding: "0.75rem 1.25rem 1rem",
                borderTop: "1px solid var(--border-default)",
              }}
            >
              {conversation.state === "human_active" && capabilities.canReplyToConversations ? (
                <ReplyComposer conversationId={conversationId} />
              ) : conversation.state === "human_active" ? (
                <p className="dvx-muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                  Your role does not have permission to send replies.
                </p>
              ) : (
                <p className="dvx-muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                  A human reply requires the conversation to be in human_active (start human
                  conversation from the Human Handover Inbox first).
                </p>
              )}
            </div>
          </div>

          <aside className="dvx-workspace-right">
            <div className="dvx-card">
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.75rem" }}>
                Contact details
              </div>
              <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <div>
                  <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
                    Name
                  </dt>
                  <dd style={{ margin: 0, fontSize: "0.85rem" }}>{displayName}</dd>
                </div>
                <div>
                  <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
                    WhatsApp number
                  </dt>
                  <dd style={{ margin: 0, fontSize: "0.85rem" }}>
                    {contact?.maskedPhoneNumber ?? "Unknown"}
                  </dd>
                </div>
                {contact?.lastDetectedLanguage ? (
                  <div>
                    <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
                      Last detected language
                    </dt>
                    <dd style={{ margin: 0, fontSize: "0.85rem" }}>
                      {contact.lastDetectedLanguage}
                    </dd>
                  </div>
                ) : null}
                {contact?.contactCreatedAt ? (
                  <div>
                    <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
                      Customer since
                    </dt>
                    <dd style={{ margin: 0, fontSize: "0.85rem" }}>
                      {new Date(contact.contactCreatedAt).toLocaleDateString()}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>

            <div className="dvx-card">
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.75rem" }}>
                Conversation info
              </div>
              <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <div>
                  <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
                    Conversation ID
                  </dt>
                  <dd style={{ margin: 0, fontSize: "0.8rem", fontFamily: "monospace" }}>
                    {conversation.id.slice(0, 8)}
                  </dd>
                </div>
                <div>
                  <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
                    Status
                  </dt>
                  <dd style={{ margin: "0.2rem 0 0" }}>
                    <ConversationStateBadge state={conversation.state} />
                  </dd>
                </div>
                <div>
                  <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
                    AI mode
                  </dt>
                  <dd style={{ margin: "0.2rem 0 0" }}>
                    <AiModeBadge aiMode={conversation.aiMode} />
                  </dd>
                </div>
                <div>
                  <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
                    Assigned to
                  </dt>
                  <dd style={{ margin: 0, fontSize: "0.85rem" }}>
                    {conversation.assignedMemberId
                      ? conversation.assignedMemberId.slice(0, 8)
                      : "Unassigned"}
                  </dd>
                </div>
                {conversation.handoverReason ? (
                  <div>
                    <dt className="dvx-muted" style={{ fontSize: "0.7rem" }}>
                      Handover reason
                    </dt>
                    <dd style={{ margin: 0, fontSize: "0.85rem" }}>
                      {conversation.handoverReason}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
