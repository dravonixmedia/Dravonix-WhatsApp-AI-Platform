import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { RealtimeRefreshBoundary } from "../../../lib/realtime/RealtimeRefreshBoundary.js";
import { CONVERSATIONS_LIST_WATCHES } from "../../../lib/realtime/watchConfigs.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { EmptyState } from "../EmptyState.js";
import { ConversationsIcon } from "../Icons.js";
import { ConversationListPanel } from "./ConversationListPanel.js";
import {
  loadConversationsListData,
  type ConversationsListSearchParams,
} from "./conversationsListData.js";

export const dynamic = "force-dynamic";

/** Phase 6: this page previously relied on RLS alone (conversations_select_member) to filter rows -- correct, but no application-level denial existed, unlike every other operational page (Leads, DRAIVA, AI Settings, Knowledge, Team). Company Accounts (finance-only) never held conversations.view; this makes that explicit here too, matching the existing pattern. */
function PermissionDenied() {
  return (
    <div className="dvx-card" style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Live Conversations</h1>
      <p className="dvx-muted" style={{ margin: 0 }}>
        Your role does not have permission to view conversations.
      </p>
    </div>
  );
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<ConversationsListSearchParams>;
}) {
  const params = await searchParams;
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canViewConversations) return <PermissionDenied />;

  const supabase = await createServerSupabaseClient();
  const data = await loadConversationsListData(
    supabase,
    session.activeCompanyId,
    session.activeMemberId,
    params,
  );

  return (
    <div className="dvx-page-fill">
      <RealtimeRefreshBoundary
        namespace="conversations-list"
        scopeId={session.activeCompanyId}
        accessToken={session.accessToken}
        watches={CONVERSATIONS_LIST_WATCHES}
      />
      <div className="dvx-workspace">
        <ConversationListPanel data={data} activeConversationId={null} />
        <div className="dvx-workspace-detail">
          <div className="dvx-workspace-center">
            <EmptyState
              icon={<ConversationsIcon size={40} />}
              title="Select a conversation"
              description="Choose a conversation from the list to view its message thread."
            />
          </div>
        </div>
      </div>
    </div>
  );
}
