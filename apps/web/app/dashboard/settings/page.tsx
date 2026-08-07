import Link from "next/link";
import { maskPhoneNumber } from "@dravonix/handover";
import { listSupportedCurrencies } from "../../../lib/currencyList.js";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { listSupportedTimezones } from "../../../lib/timezoneList.js";
import { CurrencySelect } from "./CurrencySelect.js";
import { TimezoneCombobox } from "./TimezoneCombobox.js";

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
 * Company Settings -- company configuration only (company profile,
 * business timezone/currency, subscription status, WhatsApp connection
 * summary). Team member management now lives on its own route,
 * app/dashboard/team/page.tsx -- see that file's docstring for why the
 * split happened. This page never queries company_members.
 */
export default async function SettingsPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  const canViewAnySection = capabilities.canManageSettings || capabilities.canManageBilling;

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
    capabilities.canManageSettings
      ? supabase
          .from("companies")
          .select("name, status, timezone, default_currency, created_at")
          .eq("id", session.activeCompanyId)
          .single()
      : Promise.resolve({ data: null }),
    capabilities.canManageWhatsapp
      ? supabase
          .from("whatsapp_accounts")
          .select("status, whatsapp_phone_numbers (display_phone_number)")
          .eq("company_id", session.activeCompanyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

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
        Manage your company profile, business preferences and workspace configuration.
      </p>

      <div className="dvx-card-grid dvx-card-grid--wide" style={{ marginTop: "1.5rem" }}>
        {capabilities.canManageSettings ? (
          <SectionCard id="company-details" title="Company details">
            <SettingsRow label="Company name" value={company?.name ?? null} />
            <SettingsRow
              label="Account status"
              value={company?.status ? company.status.replace(/_/g, " ") : null}
            />
            <SettingsRow label="Admin email" value={adminEmail} />
            <TimezoneCombobox
              label="Business Timezone"
              helpText="Used for business hours, operational dates and company-local scheduling context."
              initialValue={company?.timezone ?? ""}
              options={listSupportedTimezones()}
              saveLabel="Save Timezone"
            />
            <CurrencySelect
              label="Business Currency"
              helpText="Used for financial values, billing displays and business-level monetary settings."
              initialValue={company?.default_currency ?? "INR"}
              currencies={listSupportedCurrencies()}
              saveLabel="Save Currency"
            />
            <SettingsRow
              label="Created"
              value={company?.created_at ? new Date(company.created_at).toLocaleDateString() : null}
            />
          </SectionCard>
        ) : null}

        {capabilities.canManageBilling ? (
          <SectionCard title="Subscription status">
            <SettingsRow label="Current plan" value="Not configured" />
            <SettingsRow label="Subscription status" value="Not active" />
            <p className="dvx-muted" style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
              Subscription management will be available soon.
            </p>
          </SectionCard>
        ) : null}

        {capabilities.canManageWhatsapp ? (
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
