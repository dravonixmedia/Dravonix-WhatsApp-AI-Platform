import { maskPhoneNumber } from "@dravonix/handover";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ContactSummary {
  displayName: string | null;
  maskedPhoneNumber: string;
  lastDetectedLanguage: string | null;
  contactCreatedAt: string;
}

/**
 * Shared by the Live Conversations and Human Handover detail pages -- both
 * render the same "contact details" panel for a conversation, and both use
 * the same user-scoped (RLS-enforced) Supabase client already created on
 * their page. getConversationThreadForDashboard's own return shape has no
 * contact fields at all (see packages/handover/src/types.ts), so this reads
 * them the same way the conversations list already does: joining
 * conversations -> contacts by id, through the tenant-scoped client.
 */
export async function loadContactSummary(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<ContactSummary | null> {
  const { data } = await supabase
    .from("conversations")
    .select(
      "contacts (whatsapp_wa_id, display_name, profile_name, last_detected_language, created_at)",
    )
    .eq("id", conversationId)
    .single();
  const contact = data?.contacts as unknown as {
    whatsapp_wa_id: string;
    display_name: string | null;
    profile_name: string | null;
    last_detected_language: string | null;
    created_at: string;
  } | null;
  if (!contact) return null;
  return {
    displayName: contact.display_name ?? contact.profile_name,
    maskedPhoneNumber: maskPhoneNumber(contact.whatsapp_wa_id),
    lastDetectedLanguage: contact.last_detected_language,
    contactCreatedAt: contact.created_at,
  };
}
