"use server";

/**
 * Super Admin Server Actions for the configuration Dravonix now owns
 * exclusively after Client Dashboard Permission Hardening (migration
 * 00000000000022): company profile, AI/voice settings, and knowledge base
 * management. Each function is a thin wrapper around exactly one
 * migration-22 SECURITY DEFINER RPC, mirroring lib/actions/admin.ts's
 * existing pattern for the migration-17 RPC family. requireSuperAdminClient()'s
 * super_admin check here is an early, friendly rejection; the RPC itself
 * re-checks current_platform_role() independently and is the actual
 * security boundary.
 */

import { revalidatePath } from "next/cache";
import { getPlatformSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

async function requireSuperAdminClient() {
  const session = await getPlatformSession();
  if (!session || session.platformRole !== "super_admin") {
    throw new Error("Not authorized");
  }
  return createServerSupabaseClient();
}

function str(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function revalidateAdminCompanyPaths(companyId: string): void {
  revalidatePath("/admin/companies");
  revalidatePath(`/admin/companies/${companyId}`);
}

export async function adminUpdateCompanyProfileAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const name = str(formData, "name");
  if (!name) throw new Error("Company name is required");

  const { error } = await supabase.rpc("admin_update_company_profile", {
    p_company_id: companyId,
    p_name: name,
    p_industry: str(formData, "industry"),
    p_country: str(formData, "country"),
    p_timezone: str(formData, "timezone"),
    p_default_currency: str(formData, "default_currency"),
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}

export async function adminUpdateCompanyAiSettingsAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const enabledLanguages = String(formData.get("enabled_languages") ?? "en")
    .split(",")
    .map((lang) => lang.trim())
    .filter(Boolean);

  const { error } = await supabase.rpc("admin_update_company_ai_settings", {
    p_company_id: companyId,
    p_bot_name: str(formData, "bot_name"),
    p_welcome_message: str(formData, "welcome_message"),
    p_tone: str(formData, "tone"),
    p_enabled_languages: enabledLanguages.length > 0 ? enabledLanguages : ["en"],
    p_default_reply_mode: str(formData, "default_reply_mode"),
    p_ai_active: formData.get("ai_active") === "on",
    p_reply_length: str(formData, "reply_length"),
    p_unknown_answer_behavior: str(formData, "unknown_answer_behavior"),
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}

export async function adminUpdateCompanyVoiceSettingsAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();

  const { error } = await supabase.rpc("admin_update_company_voice_settings", {
    p_company_id: companyId,
    p_is_enabled: formData.get("voice_enabled") === "on",
    p_reply_mode: str(formData, "voice_reply_mode"),
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}

export async function adminAddKnowledgeSourceAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const title = str(formData, "title");
  if (!title) throw new Error("Title is required");
  const sourceType = str(formData, "source_type") ?? "faq";

  const { error } = await supabase.rpc("admin_add_knowledge_source", {
    p_company_id: companyId,
    p_source_type: sourceType,
    p_title: title,
    p_content: str(formData, "content"),
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}

export async function adminToggleKnowledgeSourceAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const sourceId = str(formData, "source_id");
  if (!sourceId) throw new Error("Source is required");

  const { error } = await supabase.rpc("admin_toggle_knowledge_source", {
    p_company_id: companyId,
    p_source_id: sourceId,
    p_next_enabled: formData.get("next_enabled") === "true",
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}

export async function adminRemoveKnowledgeSourceAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const sourceId = str(formData, "source_id");
  if (!sourceId) throw new Error("Source is required");

  const { error } = await supabase.rpc("admin_remove_knowledge_source", {
    p_company_id: companyId,
    p_source_id: sourceId,
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}
