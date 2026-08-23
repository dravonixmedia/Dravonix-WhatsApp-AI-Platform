import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const TONE_LABELS: Record<string, string> = {
  friendly_professional: "Friendly & professional",
  formal: "Formal",
  casual: "Casual",
};

const REPLY_MODE_LABELS: Record<string, string> = {
  auto: "Auto",
  text_only: "Text only",
  voice_only: "Voice only",
  text_and_voice: "Text and voice",
};

const REPLY_LENGTH_LABELS: Record<string, string> = {
  short: "Short",
  medium: "Medium",
  long: "Long",
};

const UNKNOWN_ANSWER_LABELS: Record<string, string> = {
  escalate: "Hand over to a human",
  static_fallback: "Use a fallback message",
  best_effort: "Best-effort answer",
};

function SettingsRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div
      style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.4rem 0" }}
    >
      <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
        {label}
      </span>
      <span
        style={{ fontSize: "0.85rem", textAlign: "right" }}
        className={value ? undefined : "dvx-muted"}
      >
        {value ?? "Not set"}
      </span>
    </div>
  );
}

/**
 * Client Dashboard Permission Hardening (migration 00000000000022) made
 * this page fully read-only: ai_settings.manage was revoked from every
 * client role (owner/admin/knowledge_editor) at the database level, so
 * update_ai_settings would now be rejected even if this page still
 * rendered a form -- there is no Server Action binding here at all,
 * matching the true authorization boundary. AI and voice configuration
 * are managed by Dravonix from Super Admin -> Companies -> [Company] over
 * this same company_settings/ai_settings/voice_settings schema -- no
 * duplicate settings system. Deliberately never renders an API key, model
 * provider secret, internal system prompt, platform-only research flag
 * (RESEARCH_STAGING_ENABLED), or service-role credential; only the
 * business-facing fields these tables already expose.
 */
export default async function AiSettingsPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canViewAiSettings) {
    return (
      <div className="dvx-card" style={{ maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>AI Settings</h1>
        <p className="dvx-muted" style={{ margin: 0 }}>
          Your role does not have permission to view AI settings.
        </p>
      </div>
    );
  }

  const supabase = await createServerSupabaseClient();
  const [companySettingsResult, aiSettingsResult, voiceSettingsResult] = await Promise.all([
    supabase
      .from("company_settings")
      .select("bot_name, welcome_message, tone, enabled_languages, default_reply_mode, ai_active")
      .eq("company_id", session.activeCompanyId)
      .maybeSingle(),
    supabase
      .from("ai_settings")
      .select("reply_length, unknown_answer_behavior")
      .eq("company_id", session.activeCompanyId)
      .maybeSingle(),
    supabase
      .from("voice_settings")
      .select("is_enabled, reply_mode")
      .eq("company_id", session.activeCompanyId)
      .maybeSingle(),
  ]);

  const companySettings = companySettingsResult.data;
  const aiSettings = aiSettingsResult.data;
  const voiceSettings = voiceSettingsResult.data;

  return (
    <div>
      <h1 className="dvx-page-title">AI Settings</h1>
      <p className="dvx-muted">
        How your AI assistant identifies itself, its tone, languages, and reply behavior. Changes
        are made by Dravonix.
      </p>

      <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
          Assistant identity
        </div>
        <SettingsRow label="Assistant name" value={companySettings?.bot_name ?? "Assistant"} />
        <SettingsRow label="Welcome message" value={companySettings?.welcome_message ?? null} />
        <SettingsRow
          label="Tone"
          value={
            TONE_LABELS[companySettings?.tone ?? "friendly_professional"] ??
            companySettings?.tone ??
            null
          }
        />
        <SettingsRow
          label="Supported languages"
          value={(companySettings?.enabled_languages ?? ["en"]).join(", ")}
        />

        <div
          style={{ fontWeight: 600, fontSize: "0.9rem", marginTop: "1rem", marginBottom: "0.5rem" }}
        >
          Response behavior
        </div>
        <SettingsRow
          label="AI replies"
          value={(companySettings?.ai_active ?? true) ? "Active" : "Paused"}
        />
        <SettingsRow
          label="Default reply mode"
          value={
            REPLY_MODE_LABELS[companySettings?.default_reply_mode ?? "auto"] ??
            companySettings?.default_reply_mode ??
            null
          }
        />
        <SettingsRow
          label="Reply length"
          value={
            REPLY_LENGTH_LABELS[aiSettings?.reply_length ?? "medium"] ??
            aiSettings?.reply_length ??
            null
          }
        />
        <SettingsRow
          label="When the assistant doesn't know an answer"
          value={
            UNKNOWN_ANSWER_LABELS[aiSettings?.unknown_answer_behavior ?? "escalate"] ??
            aiSettings?.unknown_answer_behavior ??
            null
          }
        />

        <div
          style={{ fontWeight: 600, fontSize: "0.9rem", marginTop: "1rem", marginBottom: "0.5rem" }}
        >
          Voice
        </div>
        <SettingsRow
          label="Voice replies"
          value={(voiceSettings?.is_enabled ?? true) ? "Enabled" : "Disabled"}
        />
        <SettingsRow
          label="Voice reply mode"
          value={
            REPLY_MODE_LABELS[voiceSettings?.reply_mode ?? "auto"] ??
            voiceSettings?.reply_mode ??
            null
          }
        />

        <p className="dvx-muted" style={{ fontSize: "0.78rem", marginTop: "1rem" }}>
          Your role can view but not change these settings.
        </p>
      </div>
    </div>
  );
}
