import {
  listHandoverInbox,
  SupabaseHandoverRepository,
  type HandoverInboxFilterKind,
  type HandoverInboxSort,
} from "@dravonix/handover";
import { RealtimeRefreshBoundary } from "../../../lib/realtime/RealtimeRefreshBoundary.js";
import { HANDOVER_INBOX_WATCHES } from "../../../lib/realtime/watchConfigs.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { EmptyState } from "../EmptyState.js";
import { HandoverIcon } from "../Icons.js";
import { HandoverQueuePanel } from "./HandoverQueuePanel.js";

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
    <div className="dvx-page-fill">
      <RealtimeRefreshBoundary
        namespace="handover-inbox"
        scopeId={session.activeCompanyId}
        accessToken={session.accessToken}
        watches={HANDOVER_INBOX_WATCHES}
      />
      <div className="dvx-workspace">
        <HandoverQueuePanel
          items={items}
          filter={filter}
          sort={sort}
          activeConversationId={null}
          callerMemberId={session.activeMemberId}
          members={members}
        />
        <div className="dvx-workspace-detail">
          <div className="dvx-workspace-center">
            <EmptyState
              icon={<HandoverIcon size={40} />}
              title="Select a conversation"
              description="The AI keeps replying by default even after a human is assigned -- use Pause AI to stop it explicitly."
            />
          </div>
        </div>
      </div>
    </div>
  );
}
