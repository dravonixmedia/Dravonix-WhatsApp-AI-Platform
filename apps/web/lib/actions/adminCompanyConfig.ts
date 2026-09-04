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
import { FILE_TOO_LARGE_CODE, prepareKnowledgeChunks } from "@dravonix/knowledge";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDomainError } from "../domainError.js";
import { logServerError } from "../serverLogging.js";
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

/**
 * Runs prepareKnowledgeChunks (clean -> chunk -> filter, real UTF-8 byte
 * size enforced) and commits the result via the ingest_knowledge_source RPC
 * -- the ONLY writer to knowledge_chunks (P2 knowledge ingestion). A
 * FileTooLargeError is translated into the RPC's own caller-supplied-message
 * path rather than a thrown action error, so an oversized submission still
 * lands as a normal, visible ingestion_error on the source (never a 500) --
 * the RPC's own last-known-good rule then decides whether that leaves the
 * source 'ready' (an already-successful source, unaffected by a bad edit) or
 * 'failed' (a source that has never successfully ingested). A genuine
 * infrastructure failure (the RPC call itself throwing) is logged via
 * logServerError with safe metadata only -- never the content/chunks -- and
 * rethrown, since that is a real operational failure, not a validation
 * outcome the RPC can represent.
 */
async function ingestKnowledgeSourceContent(
  supabase: SupabaseClient,
  companyId: string,
  sourceId: string,
  rawContent: string,
  sourceType: string,
): Promise<void> {
  let chunks: string[];
  let emptyError: string | undefined;
  try {
    chunks = prepareKnowledgeChunks(rawContent);
  } catch (error) {
    if (isDomainError(error, FILE_TOO_LARGE_CODE)) {
      chunks = [];
      emptyError = "Content exceeds the allowed size.";
    } else {
      throw error;
    }
  }

  try {
    const { error } = emptyError
      ? await supabase.rpc("ingest_knowledge_source", {
          p_company_id: companyId,
          p_source_id: sourceId,
          p_chunks: chunks,
          p_empty_error: emptyError,
        })
      : await supabase.rpc("ingest_knowledge_source", {
          p_company_id: companyId,
          p_source_id: sourceId,
          p_chunks: chunks,
        });
    if (error) throw error;
  } catch (error) {
    logServerError(
      "Failed to ingest knowledge source content",
      error,
      { companyId },
      {
        operation: "ingestKnowledgeSourceContent",
        knowledgeSourceId: sourceId,
        sourceType,
      },
    );
    throw error;
  }
}

export async function adminAddKnowledgeSourceAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const title = str(formData, "title");
  if (!title) throw new Error("Title is required");
  const sourceType = str(formData, "source_type") ?? "faq";

  const { data, error } = await supabase.rpc("admin_add_knowledge_source", {
    p_company_id: companyId,
    p_source_type: sourceType,
    p_title: title,
  });
  if (error) throw error;
  const sourceId = (data as Array<{ id: string }> | null)?.[0]?.id;
  if (!sourceId) throw new Error("Failed to create knowledge source");

  // No content submitted yet -- leave the freshly created source at its
  // schema default ('pending') rather than forcing an immediate 'failed'
  // over a deliberately empty first step; a real attempt (including a
  // whitespace-only one) below always resolves to 'ready' or 'failed'.
  const rawContent = String(formData.get("content") ?? "");
  if (rawContent.trim().length > 0) {
    await ingestKnowledgeSourceContent(supabase, companyId, sourceId, rawContent, sourceType);
  }

  revalidateAdminCompanyPaths(companyId);
}

export async function adminReingestKnowledgeSourceAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const sourceId = str(formData, "source_id");
  if (!sourceId) throw new Error("Source is required");
  const sourceType = str(formData, "source_type") ?? "faq";

  // Editing always attempts a real ingestion, even for empty/whitespace-only
  // content -- ingest_knowledge_source's own last-known-good rule (migration
  // 34) is what keeps an already-'ready' source's prior chunks fully intact
  // and the source still 'ready' if this attempt is rejected.
  const rawContent = String(formData.get("content") ?? "");
  await ingestKnowledgeSourceContent(supabase, companyId, sourceId, rawContent, sourceType);

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

/**
 * Meta/WhatsApp Batch 1 (migration 35): Super-Admin-assisted WABA + phone
 * connection management. These four actions are thin wrappers around the
 * migration's four SECURITY DEFINER RPCs -- the RPCs, not this layer, are
 * the actual authorization/tenant-ownership boundary. No Meta credential
 * (access token, app secret, verify token) is ever accepted, stored, or
 * returned by any of these -- the platform continues to send outbound
 * WhatsApp messages using the single environment-scoped META_ACCESS_TOKEN
 * secret, unchanged by this batch.
 */

export async function adminConnectWhatsappAccountAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const wabaId = str(formData, "waba_id");
  if (!wabaId) throw new Error("WABA ID is required");
  const businessName = str(formData, "business_name");
  const isTestAccount = formData.get("is_test_account") === "true";

  const { error } = await supabase.rpc("admin_connect_whatsapp_account", {
    p_company_id: companyId,
    p_waba_id: wabaId,
    p_business_name: businessName,
    p_is_test_account: isTestAccount,
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}

export async function adminConnectWhatsappPhoneNumberAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const whatsappAccountId = str(formData, "whatsapp_account_id");
  if (!whatsappAccountId) throw new Error("WhatsApp account is required");
  const phoneNumberId = str(formData, "phone_number_id");
  if (!phoneNumberId) throw new Error("Phone number ID is required");
  const displayPhoneNumber = str(formData, "display_phone_number");

  const { error } = await supabase.rpc("admin_connect_whatsapp_phone_number", {
    p_company_id: companyId,
    p_whatsapp_account_id: whatsappAccountId,
    p_phone_number_id: phoneNumberId,
    p_display_phone_number: displayPhoneNumber,
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}

export async function adminSetWhatsappAccountStatusAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const whatsappAccountId = str(formData, "whatsapp_account_id");
  if (!whatsappAccountId) throw new Error("WhatsApp account is required");
  const status = str(formData, "status");
  if (!status) throw new Error("Status is required");

  const { error } = await supabase.rpc("admin_set_whatsapp_account_status", {
    p_company_id: companyId,
    p_whatsapp_account_id: whatsappAccountId,
    p_status: status,
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}

export async function adminSetWhatsappPhoneNumberStatusAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const phoneNumberRowId = str(formData, "phone_number_row_id");
  if (!phoneNumberRowId) throw new Error("Phone number is required");
  const status = str(formData, "status");
  if (!status) throw new Error("Status is required");

  const { error } = await supabase.rpc("admin_set_whatsapp_phone_number_status", {
    p_company_id: companyId,
    p_phone_number_row_id: phoneNumberRowId,
    p_status: status,
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}

/**
 * Meta/WhatsApp Batch 2 (migration 36): registers a template Meta has
 * ALREADY approved via Business Manager -- never calls Meta, never submits
 * anything for approval. See admin_register_whatsapp_template's own doc
 * comment.
 */
export async function adminRegisterWhatsappTemplateAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const whatsappAccountId = str(formData, "whatsapp_account_id");
  if (!whatsappAccountId) throw new Error("WhatsApp account is required");
  const name = str(formData, "name");
  if (!name) throw new Error("Template name is required");
  const language = str(formData, "language");
  if (!language) throw new Error("Template language is required");

  const { error } = await supabase.rpc("admin_register_whatsapp_template", {
    p_company_id: companyId,
    p_whatsapp_account_id: whatsappAccountId,
    p_name: name,
    p_language: language,
    p_category: str(formData, "category"),
    p_status: str(formData, "status") ?? "approved",
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}

/**
 * Meta/WhatsApp Batch 2 (migration 36): designates (or, with an empty
 * selection, clears) the ONE approved template used as a WABA's
 * service-window fallback.
 */
export async function adminSetServiceWindowFallbackTemplateAction(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const supabase = await requireSuperAdminClient();
  const whatsappAccountId = str(formData, "whatsapp_account_id");
  if (!whatsappAccountId) throw new Error("WhatsApp account is required");
  const templateId = str(formData, "template_id");

  const { error } = await supabase.rpc("admin_set_service_window_fallback_template", {
    p_company_id: companyId,
    p_whatsapp_account_id: whatsappAccountId,
    p_template_id: templateId,
  });
  if (error) throw error;
  revalidateAdminCompanyPaths(companyId);
}
