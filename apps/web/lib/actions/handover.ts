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
import { createServerOnlyServiceRoleClient } from "../supabase/serviceRole.js";
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
 *
 * Phase 3A final security correction: an earlier draft resolved the raw
 * wa_id via a get_conversation_send_target RPC granted to `authenticated`.
 * That RPC's authorization check (conversations.view OR is_platform_staff(),
 * company-wide, not assignment-scoped) meant ANY authenticated caller with
 * conversations.view -- including an unassigned Sales Person, who this
 * entire phase exists to keep masked -- could call it directly via
 * Supabase-JS/PostgREST for any conversation in their company and get the
 * raw number back. Any function granted to `authenticated` is a
 * browser-callable RPC regardless of how "server-side-only" its intent is in
 * a comment -- there is no such thing as an authenticated-but-not-browser-
 * callable RPC. That function has been removed.
 *
 * The raw wa_id is resolved here instead via
 * apps/web/lib/supabase/serviceRole.ts's createServerOnlyServiceRoleClient()
 * -- this repo's one existing server-only privileged-client convention
 * (already used identically by reconcileAiOutboundMessageAction below):
 * never granted to any Postgres role at all, never importable outside the
 * server/RSC module graph (see apps/web/test/serviceRoleGuard.test.ts), and
 * its key is a server-only env var Next.js never inlines into a client
 * bundle. Authorization happens FIRST, via the normal authenticated
 * session's own RLS-scoped repo.getConversationForThread() (the same
 * tenant-checked entry point the conversation-detail page itself uses,
 * reading only id/company_id/state/ai_mode/assigned_member_id/
 * handover_reason -- no phone data at all) -- only once that succeeds does
 * this function reach for the service-role client to resolve the actual
 * send destination. The raw value is consumed immediately below to build
 * the outbound send, never logged, and never returned -- this function's
 * return type is void.
 */
export async function sendHumanReplyAction(
  conversationId: string,
  body: string,
  clientIdempotencyKey: string,
): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const { supabase, repo } = await getHandoverRepo();

  const conversation = await repo.getConversationForThread(conversationId);
  if (!conversation || conversation.companyId !== session.activeCompanyId) {
    throw new Error("Conversation not found or not accessible");
  }

  const serviceRoleClient = createServerOnlyServiceRoleClient();
  const { data: routing, error: routingError } = await serviceRoleClient
    .from("conversations")
    .select(
      "whatsapp_phone_number_id, contacts (whatsapp_wa_id), whatsapp_phone_numbers (phone_number_id)",
    )
    .eq("id", conversationId)
    .single();
  if (routingError) throw routingError;

  const routingContact = Array.isArray(routing.contacts) ? routing.contacts[0] : routing.contacts;
  const routingPhoneNumber = Array.isArray(routing.whatsapp_phone_numbers)
    ? routing.whatsapp_phone_numbers[0]
    : routing.whatsapp_phone_numbers;

  const toWaId = routingContact?.whatsapp_wa_id as string | undefined;
  const phoneNumberId = routingPhoneNumber?.phone_number_id as string | undefined;
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
