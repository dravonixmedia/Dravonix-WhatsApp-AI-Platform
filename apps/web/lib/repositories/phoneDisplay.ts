import type { SupabaseClient } from "@supabase/supabase-js";

export type PhoneVisibility = "full" | "masked";

export interface PhoneDisplayResult {
  /**
   * Named maskedPhoneNumber for backward compatibility with the many
   * existing display components (ConversationListPanel, HandoverQueuePanel,
   * GlobalSearch, leads pages, NotificationBell, DraivaConversationList, ...) that
   * already render this field -- despite the name, it now holds either the
   * full or masked value depending on phoneVisibility, resolved entirely
   * server-side by get_conversation_phone_displays/get_lead_phone_displays
   * (migration 25). A caller who is not authorized for a row never sees
   * anything but the masked string here -- the raw value is never present
   * in the RPC's result for that row at all, so there is no separate "raw"
   * field to accidentally leak.
   */
  maskedPhoneNumber: string;
  phoneVisibility: PhoneVisibility;
}

interface ConversationPhoneDisplayRow {
  conversation_id: string;
  phone_display: string;
  phone_visibility: PhoneVisibility;
}

interface LeadPhoneDisplayRow {
  lead_id: string;
  phone_display: string;
  phone_visibility: PhoneVisibility;
}

const UNKNOWN_RESULT: PhoneDisplayResult = {
  maskedPhoneNumber: "Unknown",
  phoneVisibility: "masked",
};

/**
 * Phase 3A.1: the single client-side entry point every conversation-keyed
 * read path uses to resolve a customer's phone number for display. Calls
 * get_conversation_phone_displays (migration 25) -- a SECURITY DEFINER RPC
 * that resolves the caller's identity, role, and this specific
 * conversation's own assigned_member_id entirely server-side, returning
 * either the full or masked value for each id, never both, and silently
 * omitting any id the caller isn't authorized to see at all (never a
 * masked placeholder for a conversation the caller has no legitimate
 * access to).
 *
 * One RPC call per query, batched over every conversation id the caller
 * needs -- never one call per row (see the Phase 3A.1 report's
 * "Performance/query-plan" section for why this shape was chosen).
 *
 * This never reads contacts.whatsapp_wa_id directly -- see the Phase 3A.1
 * rollout report for why direct table/column access is deliberately not
 * yet revoked (that is Phase 3A.2 / Migration 26); this function simply
 * never exercises that still-open path.
 */
export async function getConversationPhoneDisplays(
  supabase: SupabaseClient,
  conversationIds: readonly string[],
): Promise<Map<string, PhoneDisplayResult>> {
  const result = new Map<string, PhoneDisplayResult>();
  const uniqueIds = [...new Set(conversationIds)];
  if (uniqueIds.length === 0) return result;

  const { data, error } = await supabase.rpc("get_conversation_phone_displays", {
    p_conversation_ids: uniqueIds,
  });
  if (error) throw error;

  for (const row of (data ?? []) as ConversationPhoneDisplayRow[]) {
    result.set(row.conversation_id, {
      maskedPhoneNumber: row.phone_display,
      phoneVisibility: row.phone_visibility,
    });
  }
  return result;
}

/** Leads equivalent of getConversationPhoneDisplays -- see get_lead_phone_displays (migration 25). */
export async function getLeadPhoneDisplays(
  supabase: SupabaseClient,
  leadIds: readonly string[],
): Promise<Map<string, PhoneDisplayResult>> {
  const result = new Map<string, PhoneDisplayResult>();
  const uniqueIds = [...new Set(leadIds)];
  if (uniqueIds.length === 0) return result;

  const { data, error } = await supabase.rpc("get_lead_phone_displays", {
    p_lead_ids: uniqueIds,
  });
  if (error) throw error;

  for (const row of (data ?? []) as LeadPhoneDisplayRow[]) {
    result.set(row.lead_id, {
      maskedPhoneNumber: row.phone_display,
      phoneVisibility: row.phone_visibility,
    });
  }
  return result;
}

/** Looks up one id's result from a batch map, falling back to a neutral masked placeholder for a missing/null id -- never throws, matching every existing call site's current "Unknown" fallback behavior. */
export function resolvePhoneDisplay(
  map: Map<string, PhoneDisplayResult>,
  id: string | null | undefined,
): PhoneDisplayResult {
  if (!id) return UNKNOWN_RESULT;
  return map.get(id) ?? UNKNOWN_RESULT;
}

/**
 * Authorized, privacy-aware search over a company's conversations --
 * replaces a raw client-side `contacts.whatsapp_wa_id ilike ...` filter.
 * See search_company_conversations (migration 25) for the exact matching
 * rules (name matching is unrestricted; phone-digit matching is
 * last-4-only for any conversation the caller isn't already authorized
 * for full-number access on, so a full number can never be used as an
 * existence oracle against conversations outside the caller's authority).
 * Returns bare conversation ids only, never a phone value -- the caller
 * fetches full rows afterward through its own normal RLS-scoped query.
 */
export async function searchCompanyConversationIds(
  supabase: SupabaseClient,
  companyId: string,
  term: string,
  limit = 200,
): Promise<string[]> {
  const { data, error } = await supabase.rpc("search_company_conversations", {
    p_company_id: companyId,
    p_term: term,
    p_limit: limit,
  });
  if (error) throw error;
  return ((data ?? []) as Array<{ conversation_id: string }>).map((row) => row.conversation_id);
}

/** Leads equivalent of searchCompanyConversationIds -- see search_company_leads (migration 25). */
export async function searchCompanyLeadIds(
  supabase: SupabaseClient,
  companyId: string,
  term: string,
  limit = 200,
): Promise<string[]> {
  const { data, error } = await supabase.rpc("search_company_leads", {
    p_company_id: companyId,
    p_term: term,
    p_limit: limit,
  });
  if (error) throw error;
  return ((data ?? []) as Array<{ lead_id: string }>).map((row) => row.lead_id);
}
