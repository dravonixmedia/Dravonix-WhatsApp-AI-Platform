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
  NO_SERVICE_WINDOW_FALLBACK_TEMPLATE_CODE,
  pauseAi,
  reconcileOutboundMessage,
  resumeAi,
  sendHumanReply,
  sendServiceWindowReengagementTemplate,
  startHumanConversation,
  SupabaseHandoverRepository,
  WHATSAPP_SERVICE_WINDOW_CLOSED_CODE,
  type ConversationThreadMessage,
} from "@dravonix/handover";
import { GraphApiWhatsAppProvider } from "@dravonix/whatsapp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { isDomainError } from "../domainError.js";
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

interface ConversationSendTarget {
  toWaId: string;
  phoneNumberId: string;
}

/**
 * Resolves the raw wa_id/phone_number_id a WhatsApp send actually needs.
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
 * bundle. The caller MUST authorize the conversation first (tenant-checked
 * repo.getConversationForThread()) -- this function assumes that already
 * happened. The raw value returned here is consumed immediately by the
 * caller to build an outbound send, never logged, and never returned to the
 * browser.
 */
async function resolveConversationSendTarget(
  serviceRoleClient: SupabaseClient,
  conversationId: string,
): Promise<ConversationSendTarget> {
  const { data: routing, error: routingError } = await serviceRoleClient
    .from("conversations")
    .select(
      "whatsapp_phone_number_id, contacts (whatsapp_wa_id), whatsapp_phone_numbers (phone_number_id, status)",
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
  // status must be "connected" -- a disabled/not_connected/error mapping
  // must never be used to send (Meta/WhatsApp Batch 1, migration 35). Kept
  // as the same generic error as a missing mapping so this never reveals
  // *why* the number is unusable.
  const phoneNumberStatus = routingPhoneNumber?.status as string | undefined;
  if (!toWaId || !phoneNumberId || phoneNumberStatus !== "connected") {
    throw new Error("Conversation is missing WhatsApp routing information");
  }

  return { toWaId, phoneNumberId };
}

/**
 * Reads (service-role, bypassing RLS -- same trust boundary as
 * resolveConversationSendTarget above) whether this conversation's WhatsApp
 * Business Account currently has an approved service-window fallback
 * template configured. Deliberately does NOT rely on the caller's own
 * whatsapp.view grant: an agent only needs conversations.reply to send the
 * re-engagement template (reserve_human_template_outbound_message,
 * migration 36, is SECURITY DEFINER), so checking via the authenticated/RLS
 * client here could wrongly hide the button from an agent who can use it.
 * Sequential .from() calls, not an embedded select, for the same reason as
 * SupabaseHandoverWorkerRepository.getServiceWindowState: whatsapp_templates
 * has two distinct FK relationships to whatsapp_accounts, which a single
 * embed cannot disambiguate.
 */
async function hasApprovedServiceWindowFallbackTemplate(
  serviceRoleClient: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const { data: conversation } = await serviceRoleClient
    .from("conversations")
    .select("whatsapp_phone_number_id")
    .eq("id", conversationId)
    .maybeSingle();
  const phoneNumberId = conversation?.whatsapp_phone_number_id as string | null | undefined;
  if (!phoneNumberId) return false;

  const { data: phoneNumber } = await serviceRoleClient
    .from("whatsapp_phone_numbers")
    .select("whatsapp_account_id")
    .eq("id", phoneNumberId)
    .maybeSingle();
  const whatsappAccountId = phoneNumber?.whatsapp_account_id as string | null | undefined;
  if (!whatsappAccountId) return false;

  const { data: account } = await serviceRoleClient
    .from("whatsapp_accounts")
    .select("service_window_fallback_template_id")
    .eq("id", whatsappAccountId)
    .maybeSingle();
  const templateId = account?.service_window_fallback_template_id as string | null | undefined;
  if (!templateId) return false;

  const { data: template } = await serviceRoleClient
    .from("whatsapp_templates")
    .select("status")
    .eq("id", templateId)
    .maybeSingle();
  return template?.status === "approved";
}

export interface SendHumanReplyActionResult {
  success: boolean;
  /** Safe, user-facing message -- set whenever success is false. */
  error?: string;
  /** True specifically when the send was blocked by a closed service window (never a generic failure). */
  windowClosed?: boolean;
  /** Only meaningful when windowClosed is true. */
  canSendReengagementTemplate?: boolean;
}

/**
 * Sends a human reply (Human Handover Inbox final plan section 11): looks up
 * the conversation's phone_number_id/contact wa_id, then delegates to
 * @dravonix/handover's sendHumanReply, which checks the WhatsApp 24-hour
 * customer service window (Meta/WhatsApp Batch 2), reserves the outbound
 * message, checks whatsapp_send entitlement, calls the real WhatsApp
 * provider, and finalizes/classifies the result -- all before this action
 * returns.
 *
 * Outside the window, sendHumanReply throws WhatsAppServiceWindowClosedError
 * before anything is reserved/sent -- this is an expected, normal business
 * outcome (a defect found during Batch 2 staging verification let it
 * escape as a thrown Server Action exception, which Next.js's production
 * build redacts into a generic, undiagnosable digest error). It is caught
 * here specifically and returned as a typed, serializable result instead of
 * being thrown, so the UI can render the exact intended copy. Any other
 * error is rethrown unchanged -- deliberately not "fixed" here, since only
 * this one expected domain outcome is safe to turn into a normal result.
 */
export async function sendHumanReplyAction(
  conversationId: string,
  body: string,
  clientIdempotencyKey: string,
): Promise<SendHumanReplyActionResult> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const { supabase, repo } = await getHandoverRepo();

  const conversation = await repo.getConversationForThread(conversationId);
  if (!conversation || conversation.companyId !== session.activeCompanyId) {
    throw new Error("Conversation not found or not accessible");
  }

  const serviceRoleClient = createServerOnlyServiceRoleClient();
  const { toWaId, phoneNumberId } = await resolveConversationSendTarget(
    serviceRoleClient,
    conversationId,
  );

  const env = loadEnv(process.env);
  if (!env.META_ACCESS_TOKEN) {
    throw new Error("META_ACCESS_TOKEN is not configured");
  }

  try {
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
  } catch (error) {
    if (isDomainError(error, WHATSAPP_SERVICE_WINDOW_CLOSED_CODE)) {
      const canSendReengagementTemplate = await hasApprovedServiceWindowFallbackTemplate(
        serviceRoleClient,
        conversationId,
      );
      return {
        success: false,
        error: error.message,
        windowClosed: true,
        canSendReengagementTemplate,
      };
    }
    throw error;
  }

  revalidateHandoverPaths(conversationId);
  return { success: true };
}

export interface SendServiceWindowTemplateActionResult {
  success: boolean;
  /** Safe, user-facing message -- set whenever success is false. */
  error?: string;
  /** True specifically when no approved fallback template is configured (never a generic failure). */
  noFallbackConfigured?: boolean;
}

/**
 * Meta/WhatsApp Batch 2, Phase 8: lets an assigned/authorized human agent
 * deliberately send the conversation's configured re-engagement template
 * once the free-form service window has closed. Never accepts a template
 * id/name from the browser -- @dravonix/handover's
 * sendServiceWindowReengagementTemplate resolves and validates the ONE
 * account-configured, currently-approved fallback template itself.
 *
 * NoServiceWindowFallbackTemplateError (no approved fallback configured) is
 * an expected, normal business outcome -- caught here and returned as a
 * typed result, for the same reason and by the same pattern as
 * sendHumanReplyAction's WhatsAppServiceWindowClosedError handling above.
 * Any other error is rethrown unchanged.
 */
export async function sendServiceWindowTemplateAction(
  conversationId: string,
  clientIdempotencyKey: string,
): Promise<SendServiceWindowTemplateActionResult> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const { repo } = await getHandoverRepo();

  const conversation = await repo.getConversationForThread(conversationId);
  if (!conversation || conversation.companyId !== session.activeCompanyId) {
    throw new Error("Conversation not found or not accessible");
  }

  const serviceRoleClient = createServerOnlyServiceRoleClient();
  const { toWaId, phoneNumberId } = await resolveConversationSendTarget(
    serviceRoleClient,
    conversationId,
  );

  const env = loadEnv(process.env);
  if (!env.META_ACCESS_TOKEN) {
    throw new Error("META_ACCESS_TOKEN is not configured");
  }

  try {
    await sendServiceWindowReengagementTemplate(
      repo,
      new GraphApiWhatsAppProvider({
        accessToken: env.META_ACCESS_TOKEN,
        graphApiVersion: env.META_GRAPH_API_VERSION,
      }),
      { conversationId, idempotencyKey: clientIdempotencyKey, phoneNumberId, toWaId },
    );
  } catch (error) {
    if (isDomainError(error, NO_SERVICE_WINDOW_FALLBACK_TEMPLATE_CODE)) {
      return { success: false, error: error.message, noFallbackConfigured: true };
    }
    throw error;
  }

  revalidateHandoverPaths(conversationId);
  return { success: true };
}
