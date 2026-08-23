import Link from "next/link";
import { maskPhoneNumber } from "@dravonix/handover";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

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
        {value ?? "Not provided"}
      </span>
    </div>
  );
}

function SectionCard({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="dvx-card" style={{ scrollMarginTop: "1.5rem" }}>
      <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>{title}</div>
      {children}
    </div>
  );
}

/**
 * Company Settings -- Client Dashboard Permission Hardening (migration
 * 00000000000022) made this page fully read-only: settings.manage was
 * revoked from every client role at the database level, so
 * update_company_profile/update_company_timezone/update_company_currency
 * would now be rejected even if this page still rendered forms for them.
 * Company profile, timezone and currency are managed by Dravonix from
 * Super Admin -> Companies -> [Company] via admin_update_company_profile.
 * Team member management lives on its own route,
 * app/dashboard/team/page.tsx. This page never queries company_members.
 */
export default async function SettingsPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  const canViewAnySection = capabilities.canViewSettings || capabilities.canViewBilling;

  if (!canViewAnySection) {
    return (
      <div className="dvx-card" style={{ maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Company Settings</h1>
        <p className="dvx-muted" style={{ margin: 0 }}>
          Your role does not have permission to view company settings.
        </p>
      </div>
    );
  }

  const supabase = await createServerSupabaseClient();

  const [companyResult, whatsappAccountResult] = await Promise.all([
    capabilities.canViewSettings
      ? supabase
          .from("companies")
          .select(
            "name, industry, country, status, is_demo, timezone, default_currency, created_at",
          )
          .eq("id", session.activeCompanyId)
          .single()
      : Promise.resolve({ data: null }),
    capabilities.canViewWhatsapp
      ? supabase
          .from("whatsapp_accounts")
          .select("status, whatsapp_phone_numbers (display_phone_number)")
          .eq("company_id", session.activeCompanyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const subscriptionResult = capabilities.canViewBilling
    ? await supabase
        .from("subscriptions")
        .select("state, plan_versions (plans (name))")
        .eq("company_id", session.activeCompanyId)
        .maybeSingle()
    : { data: null };
  const subscriptionRow = subscriptionResult.data as {
    state: string;
    plan_versions: { plans: { name: string } | { name: string }[] | null } | null;
  } | null;
  const planVersion = subscriptionRow?.plan_versions;
  const planInfo = Array.isArray(planVersion?.plans) ? planVersion?.plans[0] : planVersion?.plans;

  const company = companyResult.data;
  const whatsappAccount = whatsappAccountResult.data as {
    status: string;
    whatsapp_phone_numbers: { display_phone_number: string | null }[] | null;
  } | null;
  const whatsappPhone = whatsappAccount?.whatsapp_phone_numbers?.[0]?.display_phone_number ?? null;

  // The only real, non-fabricated "admin email" this session can safely
  // resolve without a new profiles/email lookup: the caller's own email,
  // and only when their own role genuinely is an account-admin role.
  const adminEmail =
    company && (session.activeRole === "company_owner" || session.activeRole === "company_admin")
      ? session.email
      : null;

  return (
    <div>
      <h1 className="dvx-page-title">Company Settings</h1>
      <p className="dvx-muted">
        View your company profile, business preferences and workspace configuration. Changes are
        made by Dravonix.
      </p>

      <div className="dvx-card-grid dvx-card-grid--wide" style={{ marginTop: "1.5rem" }}>
        {capabilities.canViewSettings ? (
          <SectionCard id="company-details" title="Company details">
            {company?.is_demo ? (
              <div
                className="dvx-badge dvx-badge--neutral"
                style={{ marginBottom: "0.75rem", display: "inline-block" }}
              >
                Demo / Test Account
              </div>
            ) : null}
            <SettingsRow label="Company name" value={company?.name ?? null} />
            <SettingsRow label="Industry" value={company?.industry ?? null} />
            <SettingsRow label="Country" value={company?.country ?? null} />
            <SettingsRow
              label="Account status"
              value={company?.status ? company.status.replace(/_/g, " ") : null}
            />
            <SettingsRow label="Admin email" value={adminEmail} />
            <SettingsRow label="Business timezone" value={company?.timezone ?? null} />
            <SettingsRow label="Business currency" value={company?.default_currency ?? null} />
            <SettingsRow
              label="Created"
              value={company?.created_at ? new Date(company.created_at).toLocaleDateString() : null}
            />
            <p className="dvx-muted" style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
              Company profile, timezone and currency are managed by Dravonix -- contact your account
              representative to request a change.
            </p>
          </SectionCard>
        ) : null}

        {capabilities.canViewBilling ? (
          <SectionCard title="Subscription status">
            <SettingsRow label="Current plan" value={planInfo?.name ?? "Not assigned"} />
            <SettingsRow
              label="Subscription status"
              value={
                subscriptionRow?.state ? subscriptionRow.state.replace(/_/g, " ") : "Not active"
              }
            />
            <p className="dvx-muted" style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
              Plan assignment and billing changes are managed by Dravonix -- contact your account
              representative to change plans.
            </p>
          </SectionCard>
        ) : null}

        {capabilities.canViewWhatsapp ? (
          <SectionCard title="WhatsApp connection">
            <SettingsRow
              label="Connection status"
              value={whatsappAccount?.status ? whatsappAccount.status.replace(/_/g, " ") : null}
            />
            <SettingsRow
              label="Connected number"
              value={whatsappPhone ? maskPhoneNumber(whatsappPhone) : null}
            />
            <div style={{ marginTop: "0.75rem" }}>
              <Link
                href="/dashboard/settings/whatsapp"
                className="dvx-button dvx-button--secondary"
                style={{ fontSize: "0.8rem", textDecoration: "none" }}
              >
                View WhatsApp connection
              </Link>
            </div>
          </SectionCard>
        ) : null}
      </div>
    </div>
  );
}
