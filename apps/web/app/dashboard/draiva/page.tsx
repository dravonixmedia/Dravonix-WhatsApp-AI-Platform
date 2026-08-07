import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { RealtimeRefreshBoundary } from "../../../lib/realtime/RealtimeRefreshBoundary.js";
import { CONVERSATIONS_LIST_WATCHES } from "../../../lib/realtime/watchConfigs.js";
import { listConversations } from "../../../lib/repositories/conversationsRepository.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { DraivaWorkspace } from "./DraivaWorkspace.js";

export const dynamic = "force-dynamic";

const DRAIVA_CONVERSATION_PAGE_SIZE = 50;

/**
 * Dedicated DRAIVA staff workspace. Server-side authorization mirrors the
 * conversation-detail composer's own gate exactly (canReplyToConversations
 * -- see chatAgentAction.ts's identical check): a role without it never
 * receives the workspace or the underlying conversation list, only this
 * plain message -- never relies on the sidebar simply not showing the link.
 */
export default async function DraivaPage() {
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
  // Reuses listConversations verbatim (the same, already tenant-scoped and
  // tested query behind /dashboard/conversations) for the left-column
  // selector -- no new conversation-loading logic. Search here is a client-
  // side filter over this same page rather than a second server round trip;
  // "recent conversations" is what the spec asks the selector to show, not
  // an exhaustive company-wide search.
  const { items } = await listConversations(supabase, {
    companyId: session.activeCompanyId,
    callerMemberId: session.activeMemberId,
    page: 1,
    pageSize: DRAIVA_CONVERSATION_PAGE_SIZE,
  });

  return (
    <div className="dvx-page-fill">
      <RealtimeRefreshBoundary
        namespace="draiva-conversations"
        scopeId={session.activeCompanyId}
        accessToken={session.accessToken}
        watches={CONVERSATIONS_LIST_WATCHES}
      />
      <div className="dvx-draiva-page-header">
        <span className="dvx-draiva-page-title">DRAIVA</span>
        <span className="dvx-draiva-page-subtitle">
          AI Conversation Assistant by
          <span className="dvx-draiva-brand"> Dravonix</span>
        </span>
        <p className="dvx-draiva-page-description">
          Analyse conversations, prepare replies, translate messages and extract customer insights.
        </p>
      </div>
      <DraivaWorkspace conversations={items} />
    </div>
  );
}
