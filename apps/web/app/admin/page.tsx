import { loadEnv } from "@dravonix/config";
import { createServerSupabaseClient } from "../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

interface EmailDeliveryDiagnostics {
  zeptoMailTokenPresent: boolean;
  emailFromAddressPresent: boolean;
  emailFromNamePresent: boolean;
  appUrlPresent: boolean;
  emailConfigured: boolean;
}

/**
 * Presence-only diagnostic for the invitation-email provider config
 * (packages/config/src/env.ts). Reports whether each required value is
 * bound to *this* running Worker -- never the value itself -- so a
 * Cloudflare secret/var added after the last deploy (or added to the wrong
 * environment/script) can be confirmed or ruled out without any Cloudflare
 * account access. Diagnosed need: a real staging invitation attempt failed
 * with error_code "not_configured" (audit_logs), meaning emailConfigured
 * was false, but nothing in this codebase could previously answer *which*
 * of the four values was missing without reading a secret.
 */
function getEmailDeliveryDiagnostics(): EmailDeliveryDiagnostics {
  const env = loadEnv(process.env);
  return {
    zeptoMailTokenPresent: Boolean(env.emailApiToken),
    emailFromAddressPresent: Boolean(env.EMAIL_FROM_ADDRESS),
    emailFromNamePresent: Boolean(env.EMAIL_FROM_NAME),
    appUrlPresent: Boolean(env.APP_URL),
    emailConfigured: env.emailConfigured,
  };
}

interface PlatformCounts {
  totalCompanies: number;
  activeCompanies: number;
  platformUsers: number;
  openHandovers: number;
}

/**
 * Every count below is a real, cross-tenant COUNT query (head: true -- no
 * rows transferred), never a fabricated number. No new authorization logic
 * is introduced: these run through the same RLS-scoped client every
 * /dashboard/* page uses, and each of these four tables already has an
 * `OR is_platform_staff()` clause on its SELECT policy (confirmed against
 * the live schema) -- app/admin/layout.tsx has already established that the
 * caller genuinely is an active super_admin before this page ever renders,
 * so these queries return the true platform-wide totals rather than being
 * silently filtered down to zero rows the way a non-staff caller's would be.
 */
async function loadPlatformCounts(): Promise<PlatformCounts> {
  const supabase = await createServerSupabaseClient();

  const [companies, activeCompanies, platformUsers, openHandovers] = await Promise.all([
    supabase.from("companies").select("id", { count: "exact", head: true }),
    supabase.from("companies").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase
      .from("platform_members")
      .select("user_id", { count: "exact", head: true })
      .eq("is_active", true),
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .in("state", ["handover_requested", "queued_for_agent", "human_active"]),
  ]);

  return {
    totalCompanies: companies.count ?? 0,
    activeCompanies: activeCompanies.count ?? 0,
    platformUsers: platformUsers.count ?? 0,
    openHandovers: openHandovers.count ?? 0,
  };
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="dvx-card dvx-kpi-card">
      <span className="dvx-kpi-value">{value}</span>
      <span className="dvx-kpi-label">{label}</span>
    </div>
  );
}

function PresenceRow({ label, present }: { label: string; present: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}>
      <span style={{ fontSize: "0.85rem" }}>{label}</span>
      <span className={`dvx-badge dvx-badge--${present ? "success" : "danger"}`}>
        {present ? "Present" : "Missing"}
      </span>
    </div>
  );
}

export default async function AdminDashboardPage() {
  const counts = await loadPlatformCounts();
  const emailDiagnostics = getEmailDeliveryDiagnostics();

  return (
    <div>
      <h1 className="dvx-page-title">Super Admin</h1>
      <p className="dvx-muted" style={{ maxWidth: 640 }}>
        Manage the DRAIVA platform, companies, users, billing and platform operations.
      </p>

      <div className="dvx-kpi-grid" style={{ marginTop: "1.5rem" }}>
        <StatTile label="Total Companies" value={counts.totalCompanies} />
        <StatTile label="Active Companies" value={counts.activeCompanies} />
        <StatTile label="Platform Users" value={counts.platformUsers} />
        <StatTile label="Open Handovers" value={counts.openHandovers} />
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.25rem" }}>Email delivery configuration</h2>
        <p className="dvx-muted" style={{ margin: "0 0 0.5rem", fontSize: "0.8rem" }}>
          Presence of the invitation-email provider config on this running Worker. Never shows the
          actual value of any secret.
        </p>
        <PresenceRow label="ZeptoMail API token" present={emailDiagnostics.zeptoMailTokenPresent} />
        <PresenceRow
          label="Sender address (EMAIL_FROM_ADDRESS)"
          present={emailDiagnostics.emailFromAddressPresent}
        />
        <PresenceRow
          label="Sender name (EMAIL_FROM_NAME)"
          present={emailDiagnostics.emailFromNamePresent}
        />
        <PresenceRow label="App URL (APP_URL)" present={emailDiagnostics.appUrlPresent} />
        <div
          style={{
            borderTop: "1px solid var(--border-default)",
            marginTop: "0.5rem",
            paddingTop: "0.5rem",
          }}
        >
          <PresenceRow
            label="Overall: invitation email delivery configured"
            present={emailDiagnostics.emailConfigured}
          />
        </div>
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>Foundation phase</h2>
        <p className="dvx-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          This is the Super Admin foundation only. Company management, billing, subscriptions,
          entitlements, usage, research, audit tooling, support access, and WhatsApp connection
          management are not implemented yet -- see the sidebar for what&apos;s coming.
        </p>
      </div>
    </div>
  );
}
