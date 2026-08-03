"use server";

import { loadEnv } from "@dravonix/config";
import {
  assignToMe,
  assignToTeamMember,
  closeConversation,
  endHumanAssistance,
  getConversationThreadForDashboard,
  markAsQueued,
  markConversationRead,
  pauseAi,
  reconcileOutboundMessage,
  resumeAi,
  sendHumanReply,
  startHumanConversation,
  SupabaseHandoverRepository,
  type ConversationThreadMessage,
} from "@dravonix/handover";
import { GraphApiWhatsAppProvider } from "@dravonix/whatsapp";
import { revalidatePath } from "next/cache";
import { SupabaseEntitlementRepository } from "../repositories/supabaseEntitlementRepository.js";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

async function getHandoverRepo() {
  const supabase = await createServerSupabaseClient();
  return { supabase, repo: new SupabaseHandoverRepository(supabase) };
}

function revalidateHandoverPaths(conversationId: string): void {
  revalidatePath("/dashboard/handover");
  revalidatePath(`/dashboard/handover/${conversationId}`);
}

export async function assignToMeAction(conversationId: string): Promise<void> {
  const { repo } = await getHandoverRepo();
  await assignToMe(repo, conversationId);
  revalidateHandoverPaths(conversationId);
}

export async function assignToTeamMemberAction(
  conversationId: string,
  targetMemberId: string,
): Promise<void> {
  const { repo } = await getHandoverRepo();
  await assignToTeamMember(repo, conversationId, targetMemberId);
  revalidateHandoverPaths(conversationId);
}

export async function markAsQueuedAction(conversationId: string): Promise<void> {
  const { repo } = await getHandoverRepo();
  await markAsQueued(repo, conversationId);
  revalidateHandoverPaths(conversationId);
}

export async function startHumanConversationAction(conversationId: string): Promise<void> {
  const { repo } = await getHandoverRepo();
  await startHumanConversation(repo, conversationId);
  revalidateHandoverPaths(conversationId);
}

export async function pauseAiAction(conversationId: string): Promise<void> {
  const { repo } = await getHandoverRepo();
  await pauseAi(repo, conversationId);
  revalidateHandoverPaths(conversationId);
}

export async function resumeAiAction(conversationId: string): Promise<void> {
  const { repo } = await getHandoverRepo();
  await resumeAi(repo, conversationId);
  revalidateHandoverPaths(conversationId);
}

export async function endHumanAssistanceAction(conversationId: string): Promise<void> {
  const { repo } = await getHandoverRepo();
  await endHumanAssistance(repo, conversationId);
  revalidateHandoverPaths(conversationId);
}

export async function closeConversationAction(conversationId: string): Promise<void> {
  const { repo } = await getHandoverRepo();
  await closeConversation(repo, conversationId);
  revalidateHandoverPaths(conversationId);
}

export async function markConversationReadAction(conversationId: string): Promise<void> {
  const { repo } = await getHandoverRepo();
  await markConversationRead(repo, conversationId);
  revalidatePath("/dashboard/handover");
}

export async function reconcileOutboundMessageAction(
  messageId: string,
  conversationId: string,
  resolution: "confirm_sent" | "confirm_not_sent",
): Promise<void> {
  const { repo } = await getHandoverRepo();
  await reconcileOutboundMessage(repo, messageId, resolution);
  revalidateHandoverPaths(conversationId);
}

/**
 * Loads one older page of a conversation's message thread (the dashboard's
 * "Load older messages" control). Reads through the authenticated,
 * RLS-protected client only -- never the service-role client -- and
 * re-derives the caller's own active company on every call, so a
 * conversationId/before cursor for a different tenant is rejected the same
 * way a missing one is (getConversationThreadForDashboard never reveals
 * which case actually happened).
 */
export async function loadOlderMessagesAction(
  conversationId: string,
  before: string,
): Promise<{ messages: ConversationThreadMessage[]; hasMore: boolean }> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const { repo } = await getHandoverRepo();
  const { thread } = await getConversationThreadForDashboard(
    repo,
    session.activeCompanyId,
    conversationId,
    { before },
  );
  return thread;
}

/**
 * Sends a human reply (Human Handover Inbox final plan section 11): looks up
 * the conversation's phone_number_id/contact wa_id, then delegates to
 * @dravonix/handover's sendHumanReply, which reserves the outbound message,
 * checks whatsapp_send entitlement, calls the real WhatsApp provider, and
 * finalizes/classifies the result -- all before this action returns.
 */
export async function sendHumanReplyAction(
  conversationId: string,
  body: string,
  clientIdempotencyKey: string,
): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const { supabase, repo } = await getHandoverRepo();

  const { data: conversation, error } = await supabase
    .from("conversations")
    .select(
      "whatsapp_phone_number_id, contacts (whatsapp_wa_id), whatsapp_phone_numbers (phone_number_id)",
    )
    .eq("id", conversationId)
    .single();
  if (error) throw error;

  const contact = Array.isArray(conversation.contacts)
    ? conversation.contacts[0]
    : conversation.contacts;
  const phoneNumber = Array.isArray(conversation.whatsapp_phone_numbers)
    ? conversation.whatsapp_phone_numbers[0]
    : conversation.whatsapp_phone_numbers;

  const toWaId = contact?.whatsapp_wa_id as string | undefined;
  const phoneNumberId = phoneNumber?.phone_number_id as string | undefined;
  if (!toWaId || !phoneNumberId) {
    throw new Error("Conversation is missing WhatsApp routing information");
  }

  const env = loadEnv(process.env);
  if (!env.META_ACCESS_TOKEN) {
    throw new Error("META_ACCESS_TOKEN is not configured");
  }

  await sendHumanReply(
    repo,
    new GraphApiWhatsAppProvider({
      accessToken: env.META_ACCESS_TOKEN,
      graphApiVersion: env.META_GRAPH_API_VERSION,
    }),
    new SupabaseEntitlementRepository(supabase),
    {
      companyId: session.activeCompanyId,
      conversationId,
      body,
      idempotencyKey: clientIdempotencyKey,
      phoneNumberId,
      toWaId,
    },
  );

  revalidateHandoverPaths(conversationId);
}
