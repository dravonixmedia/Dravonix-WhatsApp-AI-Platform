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
// Reused directly from the Human Handover module: these components are
// conversation-generic (pagination, composer, reconciliation), not
// handover-specific, so Live Conversations shares them rather than
// duplicating pagination/composer/idempotency logic.
import { ConversationThread } from "../../handover/[conversationId]/ConversationThread.js";
import { ReplyComposer } from "../../handover/[conversationId]/ReplyComposer.js";

function ActionButton({ children }: { children: React.ReactNode }) {
  return (
    <button className="dvx-button" type="submit" style={{ fontSize: "0.8rem" }}>
      {children}
    </button>
  );
}

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  const supabase = await createServerSupabaseClient();
  const repo = new SupabaseHandoverRepository(supabase);

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

  return (
    <div>
      <RealtimeRefreshBoundary
        namespace="conversation-detail"
        scopeId={conversationId}
        accessToken={session.accessToken}
        watches={CONVERSATION_DETAIL_WATCHES}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: "1.3rem", margin: 0 }}>Conversation</h1>
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            state: {conversation.state} · ai_mode: {conversation.aiMode}
            {aiLikelyProcessing ? " · AI is likely drafting a reply" : ""}
          </p>
          {conversation.handoverReason ? (
            <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
              Handover reason: {conversation.handoverReason}
            </p>
          ) : null}
        </div>
        <div
          style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", justifyContent: "flex-end" }}
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
              <select name="targetMemberId" className="dvx-input" style={{ fontSize: "0.75rem" }}>
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

      {conversation.state === "human_active" && capabilities.canReplyToConversations ? (
        <ReplyComposer conversationId={conversationId} />
      ) : conversation.state === "human_active" ? (
        <p className="dvx-muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          Your role does not have permission to send replies.
        </p>
      ) : (
        <p className="dvx-muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          A human reply requires the conversation to be in human_active (start human conversation
          from the Human Handover Inbox first).
        </p>
      )}
    </div>
  );
}
