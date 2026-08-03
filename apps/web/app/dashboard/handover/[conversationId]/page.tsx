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
  closeConversationAction,
  endHumanAssistanceAction,
  pauseAiAction,
  resumeAiAction,
} from "../../../../lib/actions/handover.js";
import { getDashboardSession } from "../../../../lib/session.js";
import { createServerSupabaseClient } from "../../../../lib/supabase/server.js";
import { ConversationThread } from "./ConversationThread.js";
import { ReplyComposer } from "./ReplyComposer.js";

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
    // whether the conversation exists in another tenant -- log only
    // sanitized identifiers/error codes server-side, then render the same
    // not-found response for a missing, cross-tenant, RLS-hidden, or
    // revoked-membership conversationId.
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

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: "1.3rem", margin: 0 }}>Conversation</h1>
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            state: {conversation.state} · ai_mode: {conversation.aiMode}
            {aiLikelyProcessing ? " · AI is likely drafting a reply" : ""}
          </p>
          {conversation.handoverReason ? (
            <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
              Reason: {conversation.handoverReason}
            </p>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {conversation.aiMode === "active" ? (
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
          )}
          {conversation.state !== "closed" && conversation.state !== "ai_active" ? (
            <form
              action={async () => {
                "use server";
                await endHumanAssistanceAction(conversationId);
              }}
            >
              <ActionButton>End human assistance</ActionButton>
            </form>
          ) : null}
          {conversation.state !== "closed" ? (
            <form
              action={async () => {
                "use server";
                await closeConversationAction(conversationId);
              }}
            >
              <ActionButton>Close conversation</ActionButton>
            </form>
          ) : null}
        </div>
      </div>

      <ConversationThread
        key={session.activeCompanyId}
        conversationId={conversationId}
        initialMessages={thread.messages}
        initialHasMore={thread.hasMore}
      />

      {conversation.state === "human_active" ? (
        <ReplyComposer conversationId={conversationId} />
      ) : (
        <p className="dvx-muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          A human reply requires the conversation to be in human_active (start human conversation
          first).
        </p>
      )}
    </div>
  );
}
