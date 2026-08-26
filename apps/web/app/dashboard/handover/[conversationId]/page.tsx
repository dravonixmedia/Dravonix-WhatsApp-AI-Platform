import {
  listHandoverInbox,
  SupabaseHandoverRepository,
  type HandoverInboxFilterKind,
  type HandoverInboxSort,
} from "@dravonix/handover";
import {
  closeConversationAction,
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
import { ConversationComposerWithAssistant } from "../../ConversationComposerWithAssistant.js";
import { loadConversationWorkspaceData } from "../../conversationWorkspaceData.js";
import { CustomerTimezoneField } from "../../CustomerTimezoneField.js";
import { WhatsAppIcon } from "../../Icons.js";
import { MarkConversationReadOnMount } from "../../MarkConversationReadOnMount.js";
import { HandoverQueuePanel } from "../HandoverQueuePanel.js";
import { ConversationThread } from "./ConversationThread.js";

function ActionButton({ children }: { children: React.ReactNode }) {
  return (
    <button className="dvx-button" type="submit" style={{ fontSize: "0.8rem" }}>
      {children}
    </button>
  );
}

/** Phase 6: application-level denial for a route that previously relied on RLS alone. */
function PermissionDenied() {
  return (
    <div className="dvx-card" style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Human Handover</h1>
      <p className="dvx-muted" style={{ margin: 0 }}>
        Your role does not have permission to view conversations.
      </p>
    </div>
  );
}

export default async function ConversationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{ filter?: string; sort?: string }>;
}) {
  const { conversationId } = await params;
  const queueParams = await searchParams;
  const filter = (queueParams.filter as HandoverInboxFilterKind | undefined) ?? "all_active";
  const sort = (queueParams.sort as HandoverInboxSort | undefined) ?? "newest_first";

  const session = await getDashboardSession();
  if (!session) return null;
  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canViewConversations) return <PermissionDenied />;

  const supabase = await createServerSupabaseClient();
  const repo = new SupabaseHandoverRepository(supabase);

  const [items, membersResult] = await Promise.all([
    listHandoverInbox(repo, {
      companyId: session.activeCompanyId,
      filter,
      sort,
      callerMemberId: session.activeMemberId,
    }),
    supabase
      .from("company_members")
      .select("id, role")
      .eq("company_id", session.activeCompanyId)
      .eq("is_active", true),
  ]);

  const { conversation, thread, contact, aiLikelyProcessing } = await loadConversationWorkspaceData(
    supabase,
    repo,
    {
      companyId: session.activeCompanyId,
      conversationId,
      // The handover detail page's own per-row assignment dropdown lives in
      // HandoverQueuePanel (fed by membersResult above), not in this
      // per-conversation panel, so it never needs the shared loader's
      // members-for-assign-dropdown fetch.
      canAssignConversations: false,
    },
  );

  const displayName = contact?.displayName ?? contact?.maskedPhoneNumber ?? "Customer";

  return (
    <div className="dvx-page-fill">
      <RealtimeRefreshBoundary
        namespace="conversation-detail"
        scopeId={conversationId}
        accessToken={session.accessToken}
        watches={CONVERSATION_DETAIL_WATCHES}
      />
      <MarkConversationReadOnMount conversationId={conversationId} />
      <div className="dvx-workspace">
        <HandoverQueuePanel
          items={items}
          filter={filter}
          sort={sort}
          activeConversationId={conversationId}
          callerMemberId={session.activeMemberId}
          members={membersResult.data}
        />

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
              {conversation.state === "human_active" ? (
                <ConversationComposerWithAssistant conversationId={conversationId} />
              ) : (
                <p className="dvx-muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                  A human reply requires the conversation to be in human_active (start human
                  conversation first).
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
                {contact ? (
                  <CustomerTimezoneField
                    contactId={contact.contactId}
                    timezone={contact.timezone}
                    canEdit={capabilities.canReplyToConversations}
                  />
                ) : null}
              </dl>
            </div>

            <div className="dvx-card">
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.75rem" }}>
                Handover info
              </div>
              <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
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
                      Reason
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
