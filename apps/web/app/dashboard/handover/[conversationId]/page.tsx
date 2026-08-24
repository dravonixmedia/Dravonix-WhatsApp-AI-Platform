import {
  deriveAiLikelyProcessing,
  getConversationThreadForDashboard,
  listHandoverInbox,
  SupabaseHandoverRepository,
  type HandoverInboxFilterKind,
  type HandoverInboxSort,
} from "@dravonix/handover";
import { loadEnv } from "@dravonix/config";
import { AppError } from "@dravonix/core";
import { createLogger } from "@dravonix/observability";
import { notFound } from "next/navigation";
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
import { CustomerTimezoneField } from "../../CustomerTimezoneField.js";
import { WhatsAppIcon } from "../../Icons.js";
import { loadContactSummary } from "../../loadContactSummary.js";
import { MarkConversationReadOnMount } from "../../MarkConversationReadOnMount.js";
import { ConversationComposerWithAssistant } from "../../ConversationComposerWithAssistant.js";
import { ConversationThread } from "./ConversationThread.js";
import { HandoverQueuePanel } from "../HandoverQueuePanel.js";

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
  searchParams: Promise<{ filter?: string; sort?: string }>;
}) {
  const { conversationId } = await params;
  const queueParams = await searchParams;
  const filter = (queueParams.filter as HandoverInboxFilterKind | undefined) ?? "all_active";
  const sort = (queueParams.sort as HandoverInboxSort | undefined) ?? "newest_first";

  const session = await getDashboardSession();
  if (!session) return null;
  const capabilities = getDashboardCapabilities(session.activeRole);

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
