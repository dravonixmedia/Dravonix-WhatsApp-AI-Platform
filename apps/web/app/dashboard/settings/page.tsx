import Link from "next/link";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  company_owner: "Owner",
  company_admin: "Admin",
  manager: "Manager",
  agent: "Agent",
  knowledge_editor: "Knowledge Editor",
  billing_viewer: "Billing Viewer",
  viewer: "Viewer",
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
        {value ?? "Not configured"}
      </span>
    </div>
  );
}

function PermissionDenied() {
  return (
    <div className="dvx-card" style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Settings</h1>
      <p className="dvx-muted" style={{ margin: 0 }}>
        Your role does not have permission to view company settings.
      </p>
    </div>
  );
}

export default async function SettingsPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canManageSettings) return <PermissionDenied />;

  const supabase = await createServerSupabaseClient();
  const roleLabel = ROLE_LABELS[session.activeRole] ?? session.activeRole;

  const [companyResult, membersResult, aiSettingsResult, voiceSettingsResult] = await Promise.all([
    supabase
      .from("companies")
      .select("name, slug, status, timezone, default_currency, created_at")
      .eq("id", session.activeCompanyId)
      .single(),
    supabase
      .from("company_members")
      .select("role")
      .eq("company_id", session.activeCompanyId)
      .eq("is_active", true),
    capabilities.canViewAiSettings
      ? supabase
          .from("company_settings")
          .select(
            "bot_name, tone, default_reply_mode, confidence_threshold, ai_active, enabled_languages",
          )
          .eq("company_id", session.activeCompanyId)
          .single()
      : Promise.resolve({ data: null }),
    capabilities.canViewAiSettings
      ? supabase
          .from("voice_settings")
          .select("is_enabled, provider, reply_mode, retention_days, fallback_behavior")
          .eq("company_id", session.activeCompanyId)
          .single()
      : Promise.resolve({ data: null }),
  ]);

  const company = companyResult.data;
  const members = membersResult.data ?? [];
  const roleCounts = members.reduce<Record<string, number>>((acc, m) => {
    const role = m.role as string;
    acc[role] = (acc[role] ?? 0) + 1;
    return acc;
  }, {});
  const aiSettings = aiSettingsResult.data;
  const voiceSettings = voiceSettingsResult.data;

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem" }}>Settings</h1>
      <p className="dvx-muted">Company profile, team, and configuration for this account.</p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "1rem",
          marginTop: "1.5rem",
        }}
      >
        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
            Company profile
          </div>
          <SettingsRow label="Name" value={company?.name ?? null} />
          <SettingsRow label="Status" value={company?.status ?? null} />
          <SettingsRow label="Timezone" value={company?.timezone ?? null} />
          <SettingsRow label="Currency" value={company?.default_currency ?? null} />
          <SettingsRow
            label="Created"
            value={company?.created_at ? new Date(company.created_at).toLocaleDateString() : null}
          />
        </div>

        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
            Signed-in user
          </div>
          <SettingsRow label="Email" value={session.email} />
          <SettingsRow label="Role" value={roleLabel} />
          {session.memberships.length > 1 ? (
            <SettingsRow label="Company memberships" value={String(session.memberships.length)} />
          ) : null}
        </div>

        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>Team</div>
          <SettingsRow label="Active members" value={String(members.length)} />
          {Object.entries(roleCounts).map(([role, count]) => (
            <SettingsRow key={role} label={ROLE_LABELS[role] ?? role} value={String(count)} />
          ))}
        </div>

        {capabilities.canViewAiSettings && aiSettings ? (
          <div className="dvx-card">
            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
              AI behaviour
            </div>
            <SettingsRow label="Assistant name" value={aiSettings.bot_name} />
            <SettingsRow label="Tone" value={aiSettings.tone} />
            <SettingsRow label="Reply mode" value={aiSettings.default_reply_mode} />
            <SettingsRow label="AI automation" value={aiSettings.ai_active ? "Active" : "Paused"} />
            <SettingsRow
              label="Enabled languages"
              value={
                aiSettings.enabled_languages?.length
                  ? (aiSettings.enabled_languages as string[]).join(", ")
                  : null
              }
            />
          </div>
        ) : null}

        {capabilities.canViewAiSettings && voiceSettings ? (
          <div className="dvx-card">
            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
              Voice configuration
            </div>
            <SettingsRow
              label="Voice replies"
              value={voiceSettings.is_enabled ? "Enabled" : "Disabled"}
            />
            <SettingsRow label="Provider" value={voiceSettings.provider} />
            <SettingsRow label="Reply mode" value={voiceSettings.reply_mode} />
            <SettingsRow label="Retention" value={`${voiceSettings.retention_days} days`} />
            <SettingsRow label="Fallback behaviour" value={voiceSettings.fallback_behavior} />
          </div>
        ) : null}

        {capabilities.canManageWhatsapp ? (
          <div className="dvx-card">
            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
              WhatsApp connection
            </div>
            <p className="dvx-muted" style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
              View the connected number, verified business name, and connection status.
            </p>
            <Link
              href="/dashboard/settings/whatsapp"
              className="dvx-button dvx-button--secondary"
              style={{ fontSize: "0.8rem", textDecoration: "none" }}
            >
              View WhatsApp connection
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
