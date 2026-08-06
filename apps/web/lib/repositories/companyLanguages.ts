import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatAgentSupportedLanguage } from "@dravonix/ai";

const CHAT_AGENT_SUPPORTED: readonly ChatAgentSupportedLanguage[] = ["en", "ml", "hi", "ar"];

/**
 * The company's enabled_languages, filtered to only the languages the Chat
 * Agent's Translate action actually supports -- never a raw, unvalidated DB
 * array passed straight to the UI. Defaults to English alone when no
 * company_settings row exists or none of the enabled languages are
 * Chat-Agent-supported, mirroring loadChatAgentContext's own ["en"]
 * fallback (lib/repositories/chatAgentContext.ts).
 */
export async function loadCompanyEnabledLanguages(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ChatAgentSupportedLanguage[]> {
  const { data } = await supabase
    .from("company_settings")
    .select("enabled_languages")
    .eq("company_id", companyId)
    .maybeSingle();

  const raw: unknown = data?.enabled_languages;
  const rawList = Array.isArray(raw) ? raw : [];
  const filtered = CHAT_AGENT_SUPPORTED.filter((lang) => rawList.includes(lang));
  return filtered.length > 0 ? filtered : ["en"];
}
