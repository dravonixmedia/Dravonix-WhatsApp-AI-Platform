import Link from "next/link";
import { computeOnboardingChecklist } from "../../../lib/onboarding.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const STEP_LINKS: Record<string, string> = {
  company_profile: "/dashboard/settings",
  ai_settings: "/dashboard/ai-settings",
  knowledge_base: "/dashboard/knowledge",
  team: "/dashboard/team",
  plan: "/dashboard/settings",
  whatsapp: "/dashboard/settings/whatsapp",
};

export default async function OnboardingPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const supabase = await createServerSupabaseClient();
  const [
    companyResult,
    companySettingsResult,
    knowledgeResult,
    membersResult,
    subscriptionResult,
    whatsappResult,
  ] = await Promise.all([
    supabase
      .from("companies")
      .select("industry, country")
      .eq("id", session.activeCompanyId)
      .maybeSingle(),
    supabase
      .from("company_settings")
      .select("bot_name, welcome_message")
      .eq("company_id", session.activeCompanyId)
      .maybeSingle(),
    supabase
      .from("knowledge_sources")
      .select("id", { count: "exact", head: true })
      .eq("company_id", session.activeCompanyId)
      .eq("is_enabled", true),
    supabase
      .from("company_members")
      .select("id", { count: "exact", head: true })
      .eq("company_id", session.activeCompanyId)
      .eq("is_active", true)
      .in("role", ["company_owner", "company_admin"]),
    supabase
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("company_id", session.activeCompanyId),
    supabase
      .from("whatsapp_accounts")
      .select("status")
      .eq("company_id", session.activeCompanyId)
      .maybeSingle(),
  ]);

  const company = companyResult.data;
  const companySettings = companySettingsResult.data;

  const checklist = computeOnboardingChecklist({
    hasIndustry: Boolean(company?.industry),
    hasCountry: Boolean(company?.country),
    aiSettingsConfigured: Boolean(
      (companySettings?.bot_name && companySettings.bot_name !== "Assistant") ||
      companySettings?.welcome_message,
    ),
    enabledKnowledgeSourceCount: knowledgeResult.count ?? 0,
    activeOwnerOrAdminCount: membersResult.count ?? 0,
    hasSubscription: (subscriptionResult.count ?? 0) > 0,
    whatsappConnected: whatsappResult.data?.status === "connected",
  });

  return (
    <div>
      <h1 className="dvx-page-title">Setup Checklist</h1>
      <p className="dvx-muted">Get your workspace ready to go live.</p>

      <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1rem",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Overall readiness</span>
          <span
            className={`dvx-badge ${checklist.readyToActivate ? "dvx-badge--success" : "dvx-badge--warning"}`}
          >
            {checklist.readyToActivate ? "Ready to activate" : "In progress"}
          </span>
        </div>
        <div className="dvx-team-member-list">
          {checklist.steps.map((step) => (
            <Link
              key={step.key}
              href={STEP_LINKS[step.key] ?? "/dashboard"}
              className="dvx-team-member-row"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <span className="dvx-team-member-name">
                {step.label}
                <span className="dvx-muted" style={{ display: "block", fontSize: "0.78rem" }}>
                  {step.detail}
                </span>
              </span>
              <span
                className={`dvx-badge ${step.complete ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                style={{ fontSize: "0.7rem" }}
              >
                {step.complete ? "Complete" : "Pending"}
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <p className="dvx-muted" style={{ margin: 0, fontSize: "0.82rem" }}>
          Activation is confirmed by Dravonix once your setup is complete -- this checklist reflects
          your real progress but doesn&apos;t change your account status by itself.
        </p>
      </div>
    </div>
  );
}
