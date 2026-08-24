import type { SupabaseClient } from "@supabase/supabase-js";
import { maskPhoneNumber, type ConversationThreadMessage } from "@dravonix/handover";
import {
  selectBoundedHistory,
  type ChatAgentCompanyContext,
  type ChatAgentContactContext,
  type ChatAgentLeadContext,
  type ChatAgentMessage,
} from "@dravonix/ai";
import {
  resolveConversationTemporalContext,
  type ConversationTemporalContext,
} from "@dravonix/core";

export interface ChatAgentContext {
  messages: ChatAgentMessage[];
  historyTruncated: boolean;
  company: ChatAgentCompanyContext;
  contact: ChatAgentContactContext | null;
  lead: ChatAgentLeadContext | null;
  temporal: ConversationTemporalContext;
}

/**
 * Drops messages with no transcribable body (e.g. a voice note whose
 * transcript is still pending/failed) rather than sending an empty string to
 * the model -- mirrors packages/ai's AnthropicProvider guard for the exact
 * same case in the customer-reply pipeline.
 */
function toChatAgentMessages(messages: ConversationThreadMessage[]): ChatAgentMessage[] {
  return messages
    .filter((m) => m.body && m.body.trim().length > 0)
    .map((m) => ({
      direction: m.direction,
      senderType: m.senderType,
      body: m.body!,
      createdAt: m.createdAt,
    }));
}

/**
 * Loads only the context the Chat Agent is allowed to see, all scoped to
 * the caller's own company_id (never a value the browser could influence --
 * see lib/actions/chatAgent.ts, the only caller). Every query here is
 * additionally defense-in-depth scoped by company_id even where RLS alone
 * would already prevent cross-tenant rows, matching this repo's established
 * "belt and suspenders" convention (see conversationsRepository.ts,
 * notificationsRepository.ts).
 *
 * threadMessages must already come from getConversationThreadForDashboard,
 * which is what verified this conversation belongs to companyId in the
 * first place -- this function does not repeat that check, only the
 * additional reads (contact, lead, company AI configuration).
 */
export async function loadChatAgentContext(
  supabase: SupabaseClient,
  companyId: string,
  conversationId: string,
  threadMessages: ConversationThreadMessage[],
): Promise<ChatAgentContext> {
  const [companyResult, settingsResult, contactResult, leadResult] = await Promise.all([
    supabase.from("companies").select("name, timezone").eq("id", companyId).single(),
    supabase
      .from("company_settings")
      .select("tone, enabled_languages, fallback_language, restricted_topics")
      .eq("company_id", companyId)
      .maybeSingle(),
    supabase
      .from("conversations")
      .select(
        "contacts (whatsapp_wa_id, display_name, profile_name, last_detected_language, timezone)",
      )
      .eq("id", conversationId)
      .eq("company_id", companyId)
      .maybeSingle(),
    supabase
      .from("leads")
      .select(
        "customer_name, company_name, phone_number, email, service_interest, budget, preferred_timeline, location, notes",
      )
      .eq("conversation_id", conversationId)
      .eq("company_id", companyId)
      .maybeSingle(),
  ]);

  const { messages, truncated } = selectBoundedHistory(toChatAgentMessages(threadMessages));

  const settings = settingsResult.data;
  const company: ChatAgentCompanyContext = {
    companyName: companyResult.data?.name ?? "This company",
    tone: settings?.tone ?? "friendly_professional",
    enabledLanguages: settings?.enabled_languages ?? ["en"],
    fallbackLanguage: settings?.fallback_language ?? "en",
    restrictedTopics: settings?.restricted_topics ?? [],
  };

  type ContactRow = {
    whatsapp_wa_id: string;
    display_name: string | null;
    profile_name: string | null;
    last_detected_language: string | null;
    timezone: string | null;
  };
  const rawContact = contactResult.data?.contacts as ContactRow | ContactRow[] | null | undefined;
  const contactRow = Array.isArray(rawContact) ? rawContact[0] : rawContact;
  const contact: ChatAgentContactContext | null = contactRow
    ? {
        displayName: contactRow.display_name ?? contactRow.profile_name,
        maskedPhoneNumber: maskPhoneNumber(contactRow.whatsapp_wa_id),
        lastDetectedLanguage: contactRow.last_detected_language,
      }
    : null;

  const leadRow = leadResult.data;
  const lead: ChatAgentLeadContext | null = leadRow
    ? {
        customerName: leadRow.customer_name,
        companyName: leadRow.company_name,
        // Phase 3A.1: masked unconditionally, regardless of the caller's own
        // phone-visibility permission -- the assistant does not need the
        // literal digits to reason about a lead, so this is deliberately
        // stricter than the UI's own authorization-aware display (see the
        // Phase 3A.1 report's "DRAIVA AI privacy" section). Mirrors how
        // `contact.maskedPhoneNumber` below has always been masked here.
        phone: leadRow.phone_number ? maskPhoneNumber(leadRow.phone_number) : null,
        email: leadRow.email,
        serviceInterest: leadRow.service_interest,
        budget: leadRow.budget,
        timeline: leadRow.preferred_timeline,
        location: leadRow.location,
        notes: leadRow.notes,
      }
    : null;

  // Computed here, at request execution time -- never at module scope.
  const temporal = resolveConversationTemporalContext({
    companyTimezone: companyResult.data?.timezone,
    customerTimezone: contactRow?.timezone,
    now: new Date(),
  });

  return { messages, historyTruncated: truncated, company, contact, lead, temporal };
}
