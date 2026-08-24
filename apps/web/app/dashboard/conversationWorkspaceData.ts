import { loadEnv } from "@dravonix/config";
import { AppError } from "@dravonix/core";
import {
  deriveAiLikelyProcessing,
  getConversationThreadForDashboard,
  type SupabaseHandoverRepository,
} from "@dravonix/handover";
import { createLogger } from "@dravonix/observability";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import { loadContactSummary, type ContactSummary } from "./loadContactSummary.js";

type ThreadResult = Awaited<ReturnType<typeof getConversationThreadForDashboard>>;

export interface ConversationWorkspaceData {
  conversation: ThreadResult["conversation"];
  thread: ThreadResult["thread"];
  contact: ContactSummary | null;
  aiLikelyProcessing: boolean;
  /** Only populated when `canAssignConversations` is true -- see loadConversationWorkspaceData. */
  members: Array<{ id: string; role: string }> | null;
}

/**
 * Shared by every conversation-detail-style route (Live Conversations,
 * Human Handover, and DRAIVA's three-column workspace): the single,
 * tenant-checked entry point for a conversation's thread + contact +
 * derived UI state. Extracted so all three routes go through exactly the
 * same authorization path (getConversationThreadForDashboard) and the same
 * not-found handling -- never a second, independent way to read a
 * conversation's data.
 *
 * Calls next/navigation's notFound() directly (safe from any server
 * component render path) for a missing, cross-tenant, RLS-hidden, or
 * revoked-membership conversationId -- the caller never sees a thrown
 * error to handle itself, and the response is identical for all of those
 * cases so existence in another tenant is never revealed.
 */
export async function loadConversationWorkspaceData(
  supabase: SupabaseClient,
  repo: SupabaseHandoverRepository,
  params: {
    companyId: string;
    conversationId: string;
    canAssignConversations: boolean;
  },
): Promise<ConversationWorkspaceData> {
  const { companyId, conversationId, canAssignConversations } = params;

  let conversation: ThreadResult["conversation"];
  let thread: ThreadResult["thread"];
  try {
    const result = await getConversationThreadForDashboard(repo, companyId, conversationId);
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
      companyId,
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

  const { data: members } = canAssignConversations
    ? await supabase
        .from("company_members")
        .select("id, role")
        .eq("company_id", companyId)
        .eq("is_active", true)
    : { data: null };

  return { conversation, thread, contact, aiLikelyProcessing, members };
}
