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

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<ConversationsListSearchParams>;
}) {
  const params = await searchParams;
  const session = await getDashboardSession();
  if (!session) return null;

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
