import { maskPhoneNumber } from "@dravonix/handover";
import Link from "next/link";
import { disconnectWhatsappAccountAction } from "../../../../lib/actions/whatsappSignup.js";
import { getDashboardCapabilities } from "../../../../lib/permissions.js";
import { getDashboardSession } from "../../../../lib/session.js";
import { createServerSupabaseClient } from "../../../../lib/supabase/server.js";
import { EmptyState } from "../../EmptyState.js";
import { WhatsAppIcon } from "../../Icons.js";
import { EmbeddedSignupButton } from "./EmbeddedSignupButton.js";
import { SendTestMessageForm } from "./SendTestMessageForm.js";

export const dynamic = "force-dynamic";

/** Masks everything but the last 4 characters of a Meta-issued identifier (WABA id, phone_number_id) -- never the full value. */
function maskIdentifier(value: string): string {
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

function ConnectionRow({ label, value }: { label: string; value: string | null }) {
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
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>WhatsApp connection</h1>
      <p className="dvx-muted" style={{ margin: 0 }}>
        Your role does not have permission to view the WhatsApp connection.
      </p>
    </div>
  );
}

export default async function WhatsAppConnectionPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canViewWhatsapp) return <PermissionDenied />;

  const supabase = await createServerSupabaseClient();
  const companyId = session.activeCompanyId;

  // encrypted_access_token is never selected here, or anywhere in apps/web --
  // it exists only for the Worker-side send path (packages/whatsapp), which
  // reads it directly from Postgres via the service-role client, never
  // through this RLS-scoped dashboard query.
  const [accountResult, phoneNumbersResult, lastInboundResult, lastOutboundResult] =
    await Promise.all([
      supabase
        .from("whatsapp_accounts")
        .select(
          "id, waba_id, business_name, status, is_test_account, last_error, connection_source",
        )
        .eq("company_id", companyId)
        .maybeSingle(),
      supabase
        .from("whatsapp_phone_numbers")
        .select("id, phone_number_id, display_phone_number, status, webhook_health_checked_at")
        .eq("company_id", companyId),
      supabase
        .from("messages")
        .select("created_at")
        .eq("company_id", companyId)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("messages")
        .select("created_at")
        .eq("company_id", companyId)
        .eq("direction", "outbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const account = accountResult.data;
  const phoneNumbers = phoneNumbersResult.data ?? [];

  return (
    <div>
      <h1 className="dvx-page-title">WhatsApp connection</h1>
      <p className="dvx-muted">
        Operational connection status for this company&apos;s WhatsApp Business Account. Access
        tokens and other secrets are never displayed here.
      </p>

      {!account ? (
        <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
          <EmptyState
            icon={<WhatsAppIcon size={28} />}
            title="WhatsApp connection not yet set up"
            description={
              capabilities.canManageWhatsapp
                ? "Connect your own WhatsApp Business Account, or contact your Dravonix representative for assisted onboarding."
                : "WhatsApp connection setup is managed by Dravonix during onboarding, or by a company owner/admin. Contact your Dravonix representative to connect your WhatsApp Business Account."
            }
          />
          {capabilities.canManageWhatsapp ? (
            <div style={{ marginTop: "1rem" }}>
              <EmbeddedSignupButton hasExistingConnection={false} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="dvx-card-grid dvx-card-grid--wide" style={{ marginTop: "1.5rem" }}>
          <div className="dvx-card">
            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
              Business account
            </div>
            <ConnectionRow label="Business name" value={account.business_name} />
            <ConnectionRow label="WABA ID" value={maskIdentifier(account.waba_id)} />
            <ConnectionRow label="Status" value={account.status.replace(/_/g, " ")} />
            <ConnectionRow
              label="Environment"
              value={account.is_test_account ? "Test account" : "Production"}
            />
            {account.last_error ? (
              <ConnectionRow label="Last connection error" value={account.last_error} />
            ) : null}
          </div>

          {capabilities.canManageWhatsapp ? (
            <div className="dvx-card">
              <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
                Manage connection
              </div>
              <p className="dvx-muted" style={{ fontSize: "0.8rem", marginTop: 0 }}>
                Reconnecting updates this same connection -- it never creates a duplicate, and your
                conversation history is preserved.
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "flex-start",
                  flexWrap: "wrap",
                }}
              >
                <EmbeddedSignupButton hasExistingConnection={true} />
                {account.connection_source === "embedded_signup" ? (
                  <form action={disconnectWhatsappAccountAction.bind(null, account.id)}>
                    <button type="submit" className="dvx-button dvx-button--secondary">
                      Disconnect
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="dvx-card">
            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
              Activity
            </div>
            <ConnectionRow
              label="Last inbound message"
              value={
                lastInboundResult.data?.created_at
                  ? new Date(lastInboundResult.data.created_at).toLocaleString()
                  : null
              }
            />
            <ConnectionRow
              label="Last outbound message"
              value={
                lastOutboundResult.data?.created_at
                  ? new Date(lastOutboundResult.data.created_at).toLocaleString()
                  : null
              }
            />
          </div>

          {phoneNumbers.map((phone) => (
            <div className="dvx-card" key={phone.phone_number_id}>
              <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
                {phone.display_phone_number
                  ? maskPhoneNumber(phone.display_phone_number)
                  : "Phone number"}
              </div>
              <ConnectionRow
                label="Phone number ID"
                value={maskIdentifier(phone.phone_number_id)}
              />
              <ConnectionRow label="Status" value={phone.status.replace(/_/g, " ")} />
              <ConnectionRow
                label="Webhook last checked"
                value={
                  phone.webhook_health_checked_at
                    ? new Date(phone.webhook_health_checked_at).toLocaleString()
                    : null
                }
              />
              {capabilities.canManageWhatsapp && phone.status === "connected" ? (
                <SendTestMessageForm phoneNumberRowId={phone.id} />
              ) : null}
            </div>
          ))}
        </div>
      )}

      <p style={{ marginTop: "1.5rem" }}>
        <Link href="/dashboard/settings" className="dvx-muted" style={{ fontSize: "0.85rem" }}>
          ← Back to Settings
        </Link>
      </p>
    </div>
  );
}
