import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getConversationPhoneDisplays,
  resolvePhoneDisplay,
} from "../../lib/repositories/phoneDisplay.js";

export interface ContactSummary {
  contactId: string;
  displayName: string | null;
  maskedPhoneNumber: string;
  phoneVisibility: "full" | "masked";
  lastDetectedLanguage: string | null;
  contactCreatedAt: string;
  /** IANA timezone identifier, or null when the customer's timezone is unknown (never inferred). */
  timezone: string | null;
}

/**
 * Shared by the Live Conversations and Human Handover detail pages -- both
 * render the same "contact details" panel for a conversation, and both use
 * the same user-scoped (RLS-enforced) Supabase client already created on
 * their page. getConversationThreadForDashboard's own return shape has no
 * contact fields at all (see packages/handover/src/types.ts), so this reads
 * them the same way the conversations list already does: joining
 * conversations -> contacts by id, through the tenant-scoped client.
 *
 * Phase 3A.1: the phone number is resolved via get_conversation_phone_displays
 * (migration 25), keyed by this specific conversationId -- full for
 * company_owner/company_admin/manager/team_leader, full for a Sales Person
 * only when this exact conversation is assigned to them, masked otherwise.
 * whatsapp_wa_id itself is no longer read here at all.
 */
export async function loadContactSummary(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<ContactSummary | null> {
  const [{ data }, phoneDisplays] = await Promise.all([
    supabase
      .from("conversations")
      .select(
        "contacts (id, display_name, profile_name, last_detected_language, created_at, timezone)",
      )
      .eq("id", conversationId)
      .single(),
    getConversationPhoneDisplays(supabase, [conversationId]),
  ]);
  const contact = data?.contacts as unknown as {
    id: string;
    display_name: string | null;
    profile_name: string | null;
    last_detected_language: string | null;
    created_at: string;
    timezone: string | null;
  } | null;
  if (!contact) return null;
  const phone = resolvePhoneDisplay(phoneDisplays, conversationId);
  return {
    contactId: contact.id,
    displayName: contact.display_name ?? contact.profile_name,
    maskedPhoneNumber: phone.maskedPhoneNumber,
    phoneVisibility: phone.phoneVisibility,
    lastDetectedLanguage: contact.last_detected_language,
    contactCreatedAt: contact.created_at,
    timezone: contact.timezone,
  };
}
