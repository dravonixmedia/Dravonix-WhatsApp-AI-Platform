"use server";

/**
 * Writes directly to company_settings/ai_settings/voice_settings via the
 * RLS-scoped client -- no new RPC needed, since those tables already carry
 * "for all using(has_company_permission(company_id, 'ai_settings.manage'))"
 * policies (migration 6). A migration-18 trigger audits every change
 * (ai_settings_changed/company_settings_changed). The company id is always
 * the caller's own session-resolved activeCompanyId, never client-supplied.
 */

import { revalidatePath } from "next/cache";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

export async function updateAiSettingsAction(formData: FormData): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");

  const supabase = await createServerSupabaseClient();
  const companyId = session.activeCompanyId;

  const botName = String(formData.get("bot_name") ?? "").trim() || "Assistant";
  const tone = String(formData.get("tone") ?? "friendly_professional");
  const welcomeMessage = String(formData.get("welcome_message") ?? "").trim() || null;
  const enabledLanguages = String(formData.get("enabled_languages") ?? "en")
    .split(",")
    .map((lang) => lang.trim())
    .filter(Boolean);
  const defaultReplyMode = String(formData.get("default_reply_mode") ?? "auto");
  const aiActive = formData.get("ai_active") === "on";
  const replyLength = String(formData.get("reply_length") ?? "medium");
  const unknownAnswerBehavior = String(formData.get("unknown_answer_behavior") ?? "escalate");
  const voiceEnabled = formData.get("voice_enabled") === "on";
  const voiceReplyMode = String(formData.get("voice_reply_mode") ?? "auto");

  const { error: companySettingsError } = await supabase.from("company_settings").upsert(
    {
      company_id: companyId,
      bot_name: botName,
      welcome_message: welcomeMessage,
      tone,
      enabled_languages: enabledLanguages.length > 0 ? enabledLanguages : ["en"],
      default_reply_mode: defaultReplyMode,
      ai_active: aiActive,
    },
    { onConflict: "company_id" },
  );
  if (companySettingsError) throw new Error(companySettingsError.message);

  const { error: aiSettingsError } = await supabase.from("ai_settings").upsert(
    {
      company_id: companyId,
      reply_length: replyLength,
      unknown_answer_behavior: unknownAnswerBehavior,
    },
    { onConflict: "company_id" },
  );
  if (aiSettingsError) throw new Error(aiSettingsError.message);

  const { error: voiceSettingsError } = await supabase.from("voice_settings").upsert(
    {
      company_id: companyId,
      is_enabled: voiceEnabled,
      reply_mode: voiceReplyMode,
    },
    { onConflict: "company_id" },
  );
  if (voiceSettingsError) throw new Error(voiceSettingsError.message);

  revalidatePath("/dashboard/ai-settings");
  revalidatePath("/dashboard/onboarding");
}
