import { updateAiSettingsAction } from "../../../lib/actions/aiSettings.js";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

/**
 * Client-facing AI configuration surface over the existing schema
 * (company_settings, ai_settings, voice_settings) -- no new columns, no
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
  const readOnly = !capabilities.canManageAiSettings;

  return (
    <div>
      <h1 className="dvx-page-title">AI Settings</h1>
      <p className="dvx-muted">
        Configure how your AI assistant identifies itself, its tone, languages, and reply behavior.
      </p>

      <form action={updateAiSettingsAction} style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <fieldset disabled={readOnly} style={{ border: "none", padding: 0, margin: 0 }}>
          <div
            className="dvx-card"
            style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}
          >
            <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>Assistant identity</div>
            <label style={{ fontSize: "0.8rem" }}>
              Assistant name
              <input
                className="dvx-input"
                name="bot_name"
                defaultValue={companySettings?.bot_name ?? "Assistant"}
                style={{ marginTop: "0.3rem" }}
              />
            </label>
            <label style={{ fontSize: "0.8rem" }}>
              Welcome message
              <textarea
                className="dvx-input"
                name="welcome_message"
                defaultValue={companySettings?.welcome_message ?? ""}
                rows={2}
                style={{ marginTop: "0.3rem", resize: "vertical" }}
              />
            </label>
            <label style={{ fontSize: "0.8rem" }}>
              Tone
              <select
                className="dvx-input"
                name="tone"
                defaultValue={companySettings?.tone ?? "friendly_professional"}
                style={{ marginTop: "0.3rem" }}
              >
                <option value="friendly_professional">Friendly &amp; professional</option>
                <option value="formal">Formal</option>
                <option value="casual">Casual</option>
              </select>
            </label>
            <label style={{ fontSize: "0.8rem" }}>
              Supported languages (comma-separated, e.g. en, ml)
              <input
                className="dvx-input"
                name="enabled_languages"
                defaultValue={(companySettings?.enabled_languages ?? ["en"]).join(", ")}
                style={{ marginTop: "0.3rem" }}
              />
            </label>

            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginTop: "0.5rem" }}>
              Response behavior
            </div>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}
            >
              <input
                type="checkbox"
                name="ai_active"
                defaultChecked={companySettings?.ai_active ?? true}
              />
              AI replies are active
            </label>
            <label style={{ fontSize: "0.8rem" }}>
              Default reply mode
              <select
                className="dvx-input"
                name="default_reply_mode"
                defaultValue={companySettings?.default_reply_mode ?? "auto"}
                style={{ marginTop: "0.3rem" }}
              >
                <option value="auto">Auto</option>
                <option value="text_only">Text only</option>
                <option value="voice_only">Voice only</option>
                <option value="text_and_voice">Text and voice</option>
              </select>
            </label>
            <label style={{ fontSize: "0.8rem" }}>
              Reply length
              <select
                className="dvx-input"
                name="reply_length"
                defaultValue={aiSettings?.reply_length ?? "medium"}
                style={{ marginTop: "0.3rem" }}
              >
                <option value="short">Short</option>
                <option value="medium">Medium</option>
                <option value="long">Long</option>
              </select>
            </label>
            <label style={{ fontSize: "0.8rem" }}>
              When the assistant doesn&apos;t know an answer
              <select
                className="dvx-input"
                name="unknown_answer_behavior"
                defaultValue={aiSettings?.unknown_answer_behavior ?? "escalate"}
                style={{ marginTop: "0.3rem" }}
              >
                <option value="escalate">Hand over to a human</option>
                <option value="static_fallback">Use a fallback message</option>
                <option value="best_effort">Best-effort answer</option>
              </select>
            </label>

            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginTop: "0.5rem" }}>Voice</div>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}
            >
              <input
                type="checkbox"
                name="voice_enabled"
                defaultChecked={voiceSettings?.is_enabled ?? true}
              />
              Voice replies enabled
            </label>
            <label style={{ fontSize: "0.8rem" }}>
              Voice reply mode
              <select
                className="dvx-input"
                name="voice_reply_mode"
                defaultValue={voiceSettings?.reply_mode ?? "auto"}
                style={{ marginTop: "0.3rem" }}
              >
                <option value="auto">Auto</option>
                <option value="text_only">Text only</option>
                <option value="voice_only">Voice only</option>
                <option value="text_and_voice">Text and voice</option>
              </select>
            </label>

            {!readOnly ? (
              <button
                className="dvx-button"
                type="submit"
                style={{ alignSelf: "flex-start", marginTop: "0.5rem" }}
              >
                Save AI settings
              </button>
            ) : (
              <p className="dvx-muted" style={{ fontSize: "0.78rem", margin: 0 }}>
                Your role can view but not change these settings.
              </p>
            )}
          </div>
        </fieldset>
      </form>
    </div>
  );
}
