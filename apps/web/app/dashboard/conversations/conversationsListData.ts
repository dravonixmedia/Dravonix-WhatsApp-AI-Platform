import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listConversations,
  type ConversationListAiModeFilter,
  type ConversationListAssignmentFilter,
  type ConversationListHandoverFilter,
  type ConversationListPage,
} from "../../../lib/repositories/conversationsRepository.js";

export const CONVERSATIONS_PAGE_SIZE = 25;

export interface ConversationsListSearchParams {
  search?: string;
  aiMode?: string;
  assignment?: string;
  handover?: string;
  page?: string;
}

export interface ConversationsListData {
  page: ConversationListPage;
  search: string | undefined;
  aiMode: ConversationListAiModeFilter;
  assignment: ConversationListAssignmentFilter;
  handover: ConversationListHandoverFilter;
  pageNumber: number;
  totalPages: number;
  /** Query string (no leading "?") for the current filter state -- appended to conversation row links so opening one doesn't lose the list's filters. */
  queryString: string;
}

/**
 * Shared by both conversations/page.tsx (no conversation selected) and
 * conversations/[conversationId]/page.tsx (one selected) so the left list
 * panel reflects identical filters either way -- each route is a real
 * Next.js page, so both receive `searchParams` (only layouts don't).
 */
export async function loadConversationsListData(
  supabase: SupabaseClient,
  companyId: string,
  callerMemberId: string,
  params: ConversationsListSearchParams,
): Promise<ConversationsListData> {
  const aiMode = (params.aiMode as ConversationListAiModeFilter | undefined) ?? "all";
  const assignment = (params.assignment as ConversationListAssignmentFilter | undefined) ?? "all";
  const handover = (params.handover as ConversationListHandoverFilter | undefined) ?? "all";
  const pageNumber = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const page = await listConversations(supabase, {
    companyId,
    callerMemberId,
    search: params.search,
    aiMode,
    assignment,
    handover,
    page: pageNumber,
    pageSize: CONVERSATIONS_PAGE_SIZE,
  });

  const totalPages = Math.max(1, Math.ceil(page.totalCount / CONVERSATIONS_PAGE_SIZE));
  const queryString = new URLSearchParams({
    ...(params.search ? { search: params.search } : {}),
    aiMode,
    assignment,
    handover,
  }).toString();

  return {
    page,
    search: params.search,
    aiMode,
    assignment,
    handover,
    pageNumber,
    totalPages,
    queryString,
  };
}
