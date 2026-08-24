import { SupabaseHandoverRepository } from "@dravonix/handover";
import {
  closeConversationAction,
  endHumanAssistanceAction,
  pauseAiAction,
  resumeAiAction,
} from "../../../../lib/actions/handover.js";
import { getDashboardCapabilities } from "../../../../lib/permissions.js";
import { RealtimeRefreshBoundary } from "../../../../lib/realtime/RealtimeRefreshBoundary.js";
import { CONVERSATION_DETAIL_WATCHES } from "../../../../lib/realtime/watchConfigs.js";
import { listConversations } from "../../../../lib/repositories/conversationsRepository.js";
import { getDashboardSession } from "../../../../lib/session.js";
import { createServerSupabaseClient } from "../../../../lib/supabase/server.js";
import { Avatar } from "../../Avatar.js";
import { loadConversationWorkspaceData } from "../../conversationWorkspaceData.js";
import { WhatsAppIcon } from "../../Icons.js";
import { MarkConversationReadOnMount } from "../../MarkConversationReadOnMount.js";
// Reused directly from the Human Handover module -- see
// conversations/[conversationId]/page.tsx's identical import for why
// (conversation-generic, not handover-specific).
import { ConversationThread } from "../../handover/[conversationId]/ConversationThread.js";
import { DraivaAssistantColumn } from "../DraivaAssistantColumn.js";
import { DraivaConversationList } from "../DraivaConversationList.js";
import { DraivaDraftProvider } from "../DraivaDraftContext.js";
import { DraivaReplyComposerSlot } from "../DraivaReplyComposerSlot.js";

export const dynamic = "force-dynamic";

const DRAIVA_CONVERSATION_PAGE_SIZE = 50;

function ActionButton({ children }: { children: React.ReactNode }) {
  return (
    <button className="dvx-button" type="submit" style={{ fontSize: "0.8rem" }}>
      {children}
    </button>
  );
}

/**
 * DRAIVA's three-column workspace with a conversation selected: the left
 * conversation list (DraivaConversationList, shared with the no-selection
 * route), the real WhatsApp thread in the center (ConversationThread,
 * reused byte-for-byte from Live Conversations/Human Handover -- same
 * Phase 3B scroll behavior, same realtime, same pagination), and DRAIVA's
 * existing Chat Agent panel on the right (ChatAgentPanel via
 * DraivaAssistantColumn), now persistent instead of an overlay.
 *
 * conversationId is a route param (not client state), so a direct link,
 * a refresh, and browser back/forward all resolve to the same selected
 * conversation -- this is the Phase 4 replacement for DraivaWorkspace's
 * old useState-only selection.
 */
export default async function DraivaConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canReplyToConversations) {
    return (
      <div className="dvx-card" style={{ maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>DRAIVA</h1>
        <p className="dvx-muted" style={{ margin: 0 }}>
          Your role does not have permission to use DRAIVA.
        </p>
      </div>
    );
  }

  const supabase = await createServerSupabaseClient();
  const repo = new SupabaseHandoverRepository(supabase);

  const [{ items }, { conversation, thread, contact, aiLikelyProcessing }] = await Promise.all([
    listConversations(supabase, {
      companyId: session.activeCompanyId,
      callerMemberId: session.activeMemberId,
      page: 1,
      pageSize: DRAIVA_CONVERSATION_PAGE_SIZE,
    }),
    loadConversationWorkspaceData(supabase, repo, {
      companyId: session.activeCompanyId,
      conversationId,
      canAssignConversations: false,
    }),
  ]);

  const displayName = contact?.displayName ?? contact?.maskedPhoneNumber ?? "Customer";

  return (
    <div className="dvx-page-fill">
      <RealtimeRefreshBoundary
        namespace="draiva-conversation-detail"
        scopeId={conversationId}
        accessToken={session.accessToken}
        watches={CONVERSATION_DETAIL_WATCHES}
      />
      <MarkConversationReadOnMount conversationId={conversationId} />
      <div className="dvx-draiva-page-header">
        <span className="dvx-draiva-page-title">DRAIVA</span>
        <span className="dvx-draiva-page-subtitle">
          AI Conversation Assistant by
          <span className="dvx-draiva-brand"> Dravonix</span>
        </span>
      </div>

      <div className="dvx-workspace">
        <DraivaConversationList conversations={items} activeConversationId={conversationId} />

        <div className="dvx-workspace-detail dvx-workspace-detail--active">
          <DraivaDraftProvider key={conversationId}>
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

                  {capabilities.canCloseConversations &&
                  conversation.state !== "closed" &&
                  conversation.state !== "ai_active" ? (
                    <form
                      action={async () => {
                        "use server";
                        await endHumanAssistanceAction(conversationId);
                      }}
                    >
                      <ActionButton>End human assistance</ActionButton>
                    </form>
                  ) : null}

                  {capabilities.canCloseConversations && conversation.state !== "closed" ? (
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
                key={conversationId}
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
                  <DraivaReplyComposerSlot conversationId={conversationId} />
                ) : conversation.state === "human_active" ? (
                  <p className="dvx-muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                    Your role does not have permission to send replies.
                  </p>
                ) : (
                  <p className="dvx-muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                    A human reply requires the conversation to be in human_active.
                  </p>
                )}
              </div>
            </div>

            <DraivaAssistantColumn conversationId={conversationId} />
          </DraivaDraftProvider>
        </div>
      </div>
    </div>
  );
}
