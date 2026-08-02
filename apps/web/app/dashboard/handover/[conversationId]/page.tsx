import {
  deriveAiLikelyProcessing,
  getConversationThread,
  markConversationRead,
  SupabaseHandoverRepository,
} from "@dravonix/handover";
import {
  closeConversationAction,
  endHumanAssistanceAction,
  pauseAiAction,
  reconcileOutboundMessageAction,
  resumeAiAction,
} from "../../../../lib/actions/handover.js";
import { getDashboardSession } from "../../../../lib/session.js";
import { createServerSupabaseClient } from "../../../../lib/supabase/server.js";
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

  const [{ data: conversation, error }, thread] = await Promise.all([
    supabase
      .from("conversations")
      .select("state, ai_mode, assigned_member_id, handover_reason")
      .eq("id", conversationId)
      .single(),
    getConversationThread(repo, conversationId),
  ]);
  if (error) throw error;

  await markConversationRead(repo, conversationId);

  const latestInbound = [...thread.messages].reverse().find((m) => m.direction === "inbound");
  const latestAiOutbound = [...thread.messages]
    .reverse()
    .find((m) => m.direction === "outbound" && m.senderType === "ai");
  const aiLikelyProcessing = deriveAiLikelyProcessing({
    aiMode: conversation.ai_mode,
    latestInboundAt: latestInbound?.createdAt ?? null,
    latestAiOutboundAt: latestAiOutbound?.createdAt ?? null,
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: "1.3rem", margin: 0 }}>Conversation</h1>
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            state: {conversation.state} · ai_mode: {conversation.ai_mode}
            {aiLikelyProcessing ? " · AI is likely drafting a reply" : ""}
          </p>
          {conversation.handover_reason ? (
            <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
              Reason: {conversation.handover_reason}
            </p>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {conversation.ai_mode === "active" ? (
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

      <div
        style={{
          marginTop: "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.6rem",
          maxHeight: "55vh",
          overflowY: "auto",
        }}
      >
        {thread.messages.map((message) => {
          const isCustomer = message.senderType === "customer";
          const needsReconcile =
            message.outboundStatus === "delivery_unknown" ||
            message.outboundStatus === "send_failed";
          return (
            <div
              key={message.id}
              className="dvx-card"
              style={{
                alignSelf: isCustomer ? "flex-start" : "flex-end",
                maxWidth: "70%",
              }}
            >
              <div className="dvx-muted" style={{ fontSize: "0.7rem", marginBottom: "0.25rem" }}>
                {message.senderType} · {message.channelType} ·{" "}
                {new Date(message.createdAt).toLocaleString()}
                {message.outboundStatus ? ` · ${message.outboundStatus}` : ""}
              </div>
              <div>{message.body}</div>
              {needsReconcile ? (
                <div style={{ display: "flex", gap: "0.3rem", marginTop: "0.4rem" }}>
                  <form
                    action={async () => {
                      "use server";
                      await reconcileOutboundMessageAction(
                        message.id,
                        conversationId,
                        "confirm_sent",
                      );
                    }}
                  >
                    <ActionButton>Confirm sent</ActionButton>
                  </form>
                  <form
                    action={async () => {
                      "use server";
                      await reconcileOutboundMessageAction(
                        message.id,
                        conversationId,
                        "confirm_not_sent",
                      );
                    }}
                  >
                    <ActionButton>Confirm not sent</ActionButton>
                  </form>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

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
