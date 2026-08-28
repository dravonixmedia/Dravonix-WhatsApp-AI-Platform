import type { SupabaseClient } from "@supabase/supabase-js";
import { logServerError } from "../serverLogging.js";
import {
  getConversationPhoneDisplays,
  getLeadPhoneDisplays,
  resolvePhoneDisplay,
  searchCompanyConversationIds,
  searchCompanyLeadIds,
} from "./phoneDisplay.js";

export const GLOBAL_SEARCH_RESULT_LIMIT = 5;
/** Caps the intermediate contact-id lookup before the conversations query -- never an unbounded scan. */
const CANDIDATE_CONTACT_LIMIT = 25;

export interface GlobalSearchConversationResult {
  conversationId: string;
  displayName: string;
  maskedPhoneNumber: string;
  phoneVisibility: "full" | "masked";
  latestMessagePreview: string | null;
}

export interface GlobalSearchLeadResult {
  leadId: string;
  displayName: string;
  stage: string;
  serviceInterest: string | null;
}

export interface GlobalSearchResults {
  conversations: GlobalSearchConversationResult[];
  leads: GlobalSearchLeadResult[];
}

/**
 * Lives here (not in lib/actions/globalSearch.ts) because Next.js requires
 * every export from a "use server" file to be an async function -- a plain
 * constant or type export there fails the production build.
 */
export const GLOBAL_SEARCH_MIN_LENGTH = 2;

/**
 * Tenant-scoped global search query logic, pulled out of
 * lib/actions/globalSearch.ts so it's directly unit-testable with a fake
 * Supabase client (matching conversationsRepository.ts/leadsRepository.ts) --
 * lib/actions/globalSearch.ts itself imports lib/session.ts, whose
 * getDashboardSession() is wrapped in React's cache() and throws when
 * imported outside Next's server-component runtime, which would make these
 * queries untestable if they lived in the same file.
 *
 * Deliberately does NOT search message body text: there is no text-search
 * index on messages.body, and matching against it would mean an unbounded
 * ILIKE scan across a tenant's entire message history on every keystroke --
 * exactly what this feature must not do. Conversation results are matched
 * by contact identity only; the latest message is shown as a preview
 * (reusing the existing single-row-per-conversation embed already used by
 * listConversations), never searched.
 */
export async function searchConversations(
  supabase: SupabaseClient,
  companyId: string,
  term: string,
): Promise<GlobalSearchConversationResult[]> {
  // Phase 3A.1: search_company_conversations (migration 25) replaces the
  // raw `contacts.whatsapp_wa_id ilike ...` filter -- see
  // conversationsRepository.ts's identical comment for the privacy
  // rationale (last-4-only phone matching outside the caller's own
  // authorized rows, never a full-number existence oracle).
  const conversationIds = await searchCompanyConversationIds(
    supabase,
    companyId,
    term,
    CANDIDATE_CONTACT_LIMIT,
  );
  if (conversationIds.length === 0) return [];

  const { data, error } = await supabase
    .from("conversations")
    .select(
      `id, contacts (display_name, profile_name),
       messages (body, channel_type, created_at)`,
    )
    .eq("company_id", companyId)
    .in("id", conversationIds)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { foreignTable: "messages", ascending: false })
    .limit(1, { foreignTable: "messages" })
    .limit(GLOBAL_SEARCH_RESULT_LIMIT);
  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    contacts: { display_name: string | null; profile_name: string | null } | null;
    messages: Array<{ body: string | null; channel_type: string }> | null;
  }>;
  const phoneDisplays = await getConversationPhoneDisplays(
    supabase,
    rows.map((row) => row.id),
  );

  return rows.map((row) => {
    const contact = row.contacts;
    const latestMessage = row.messages?.[0] ?? null;
    const phone = resolvePhoneDisplay(phoneDisplays, row.id);
    return {
      conversationId: row.id,
      displayName: contact?.display_name ?? contact?.profile_name ?? phone.maskedPhoneNumber,
      maskedPhoneNumber: phone.maskedPhoneNumber,
      phoneVisibility: phone.phoneVisibility,
      latestMessagePreview:
        latestMessage?.channel_type === "audio" ? "Voice message" : (latestMessage?.body ?? null),
    };
  });
}

export async function searchLeads(
  supabase: SupabaseClient,
  companyId: string,
  term: string,
): Promise<GlobalSearchLeadResult[]> {
  // Phase 3A.1: search_company_leads (migration 25) replaces the raw
  // `phone_number ilike ...` filter -- same privacy rationale as
  // searchConversations above.
  const leadIds = await searchCompanyLeadIds(supabase, companyId, term, GLOBAL_SEARCH_RESULT_LIMIT);
  if (leadIds.length === 0) return [];

  const { data, error } = await supabase
    .from("leads")
    .select(
      `id, customer_name, company_name, service_interest, stage,
       contacts (display_name, profile_name)`,
    )
    .eq("company_id", companyId)
    .in("id", leadIds)
    .order("updated_at", { ascending: false })
    .limit(GLOBAL_SEARCH_RESULT_LIMIT);
  if (error) {
    logServerError(
      "Failed to search leads (global search)",
      error,
      { companyId },
      { operation: "searchLeads" },
    );
    throw error;
  }

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    customer_name: string | null;
    company_name: string | null;
    service_interest: string | null;
    stage: string;
    contacts: { display_name: string | null; profile_name: string | null } | null;
  }>;
  const phoneDisplays = await getLeadPhoneDisplays(
    supabase,
    rows.map((row) => row.id),
  );

  return rows.map((row) => {
    const contactName = row.contacts?.display_name ?? row.contacts?.profile_name ?? null;
    const phone = resolvePhoneDisplay(phoneDisplays, row.id);
    const displayName =
      row.customer_name ?? contactName ?? row.company_name ?? phone.maskedPhoneNumber;
    return {
      leadId: row.id,
      displayName,
      stage: row.stage,
      serviceInterest: row.service_interest,
    };
  });
}
