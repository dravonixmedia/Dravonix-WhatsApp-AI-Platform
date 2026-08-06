import { handoverItemNeedsAttention, SupabaseHandoverRepository } from "@dravonix/handover";
import { getDashboardCapabilities } from "../../lib/permissions.js";
import { logoutAction } from "../../lib/actions/auth.js";
import { switchCompanyAction } from "../../lib/actions/company.js";
import { RealtimeRefreshBoundary } from "../../lib/realtime/RealtimeRefreshBoundary.js";
import { DASHBOARD_SHELL_WATCHES } from "../../lib/realtime/watchConfigs.js";
import { loadNotificationSummary } from "../../lib/repositories/notificationsRepository.js";
import { getDashboardSession, NoCompanyAccessError } from "../../lib/session.js";
import { createServerSupabaseClient } from "../../lib/supabase/server.js";
import { BrandIcon, BrandLogo } from "../BrandLogo.js";
import { Avatar } from "./Avatar.js";
import { GlobalSearch } from "./GlobalSearch.js";
import {
  ChevronDownIcon,
  ConversationsIcon,
  HandoverIcon,
  LeadsIcon,
  OverviewIcon,
  SettingsIcon,
  WhatsAppIcon,
} from "./Icons.js";
import { NavLinks, type NavLinkItem } from "./NavLinks.js";
import { NotificationBell } from "./NotificationBell.js";

// Every /dashboard/* route depends on the request's session cookie (real
// Supabase Auth, Human Handover Inbox final plan section 15) -- never
// statically prerenderable, and forcing this explicitly (rather than relying
// on Next's automatic dynamic-API detection) keeps a build from crashing when
// SUPABASE_URL/SUPABASE_ANON_KEY aren't configured (e.g. in CI, which never
// sets real provider secrets by design -- see .github/workflows/ci.yml).
export const dynamic = "force-dynamic";

const HANDOVER_NAV_ITEM: NavLinkItem = {
  href: "/dashboard/handover",
  label: "Human Handover",
  icon: <HandoverIcon />,
};

/**
 * Nav is built per-request from the caller's real, permission-derived
 * capabilities -- never a hardcoded email or role string. Knowledge Base is
 * omitted entirely (no client-ready management module exists yet -- see
 * app/dashboard/knowledge/page.tsx). Billing is also omitted: it has no
 * client-ready subscription system yet either (its route now redirects to
 * Settings, which shows an honest "not configured" subscription-status
 * card instead -- see app/dashboard/billing/page.tsx). Settings is shown to
 * any role holding at least one of the permissions a Settings section is
 * gated on (company details, team, or billing), and WhatsApp Connection
 * only to roles holding its own permission, so an agent or viewer never
 * sees a link to a page RLS or the page itself would then have to reject
 * them from.
 */
export function buildNavItems(
  capabilities: ReturnType<typeof getDashboardCapabilities>,
): NavLinkItem[] {
  const items: NavLinkItem[] = [
    { href: "/dashboard", label: "Overview", icon: <OverviewIcon /> },
    { href: "/dashboard/conversations", label: "Live Conversations", icon: <ConversationsIcon /> },
    { href: "/dashboard/leads", label: "Leads", icon: <LeadsIcon /> },
  ];
  if (
    capabilities.canManageSettings ||
    capabilities.canManageTeam ||
    capabilities.canManageBilling
  ) {
    items.push({ href: "/dashboard/settings", label: "Settings", icon: <SettingsIcon /> });
  }
  if (capabilities.canManageWhatsapp) {
    items.push({
      href: "/dashboard/settings/whatsapp",
      label: "WhatsApp Connection",
      icon: <WhatsAppIcon size={18} />,
    });
  }
  return items;
}

const ROLE_LABELS: Record<string, string> = {
  company_owner: "Owner",
  company_admin: "Admin",
  manager: "Manager",
  agent: "Agent",
  knowledge_editor: "Knowledge Editor",
  billing_viewer: "Billing Viewer",
  viewer: "Viewer",
};

function NoCompanyAccessPage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div className="dvx-card" style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.1rem" }}>No company access</h1>
        <p className="dvx-muted">
          Your account isn&apos;t an active member of any company yet. Ask an administrator to
          invite you, then reload this page.
        </p>
      </div>
    </main>
  );
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let session;
  try {
    session = await getDashboardSession();
  } catch (error) {
    if (error instanceof NoCompanyAccessError) {
      return <NoCompanyAccessPage />;
    }
    throw error;
  }

  if (!session) {
    // middleware.ts already redirects unauthenticated /dashboard/* requests
    // to /login -- this is defense in depth only, never expected in practice.
    return <NoCompanyAccessPage />;
  }

  const supabase = await createServerSupabaseClient();
  const handoverRepo = new SupabaseHandoverRepository(supabase);
  const [notificationSummary, handoverInboxItems] = await Promise.all([
    loadNotificationSummary(supabase, session.activeCompanyId),
    handoverRepo.listHandoverInbox({
      companyId: session.activeCompanyId,
      filter: "all_active",
      sort: "newest_first",
    }),
  ]);
  // Both the Human Handover nav badge and the bell's handover-attention
  // sections are derived from this one query, via the same shared
  // handoverItemNeedsAttention predicate SupabaseHandoverRepository's own
  // countHandoverBadge uses -- so calling that function again here would
  // just re-run an identical query; deriving locally avoids that.
  const handoverBadgeCount = handoverInboxItems.filter(handoverItemNeedsAttention).length;
  const pendingHandoverRequests = handoverInboxItems
    .filter((item) => item.state !== "human_active")
    .map((item) => ({
      conversationId: item.conversationId,
      maskedPhoneNumber: item.maskedPhoneNumber,
    }));
  const unassignedHandovers = handoverInboxItems
    .filter((item) => item.assignedMemberId === null)
    .map((item) => ({
      conversationId: item.conversationId,
      maskedPhoneNumber: item.maskedPhoneNumber,
    }));
  const capabilities = getDashboardCapabilities(session.activeRole);
  const navItems = buildNavItems(capabilities);

  const roleLabel = ROLE_LABELS[session.activeRole] ?? session.activeRole;
  const activeCompanyName =
    session.memberships.find((m) => m.companyId === session.activeCompanyId)?.companyName ??
    session.memberships[0]?.companyName ??
    "";

  return (
    <div style={{ display: "flex", height: "100dvh", overflow: "hidden" }}>
      <RealtimeRefreshBoundary
        namespace="dashboard-shell"
        scopeId={session.activeCompanyId}
        accessToken={session.accessToken}
        watches={DASHBOARD_SHELL_WATCHES}
      />
      <input
        type="checkbox"
        id="dvx-nav-toggle"
        className="dvx-nav-toggle-input"
        aria-label="Toggle navigation menu"
      />
      <label htmlFor="dvx-nav-toggle" className="dvx-nav-toggle-label" aria-hidden="true">
        <BrandIcon size={22} />
      </label>
      <a href="#dvx-main-content" className="dvx-skip-link">
        Skip to content
      </a>
      <aside
        id="dvx-sidebar-nav"
        className="dvx-sidebar"
        style={{
          width: 240,
          flexShrink: 0,
          height: "100%",
          overflowY: "auto",
          background: "var(--surface-elevated)",
          borderRight: "1px solid var(--border-default)",
          padding: "1.25rem 1rem",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{ marginBottom: "1.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}
        >
          <BrandLogo height={26} />
        </div>

        <div
          className="dvx-card"
          style={{
            padding: "0.6rem 0.75rem",
            marginBottom: "1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.15rem",
          }}
        >
          <span className="dvx-muted" style={{ fontSize: "0.68rem", textTransform: "uppercase" }}>
            Current company
          </span>
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }} title={activeCompanyName}>
            {activeCompanyName}
          </span>
          <span
            className="dvx-badge dvx-badge--neutral"
            style={{ alignSelf: "flex-start", marginTop: "0.3rem" }}
          >
            {roleLabel}
          </span>
        </div>

        <NavLinks
          items={navItems}
          handover={HANDOVER_NAV_ITEM}
          handoverBadgeCount={handoverBadgeCount}
        />

        <div
          style={{
            marginTop: "auto",
            paddingTop: "1rem",
            borderTop: "1px solid var(--border-default)",
          }}
        >
          <div
            className="dvx-muted"
            style={{
              fontSize: "0.75rem",
              marginBottom: "0.5rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={session.email ?? undefined}
          >
            {session.email}
          </div>
          <form action={logoutAction}>
            <button
              className="dvx-button dvx-button--secondary"
              type="submit"
              style={{ width: "100%" }}
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header className="dvx-topbar">
          <GlobalSearch />

          <div className="dvx-topbar-actions">
            {session.memberships.length > 1 ? (
              <form
                action={async (formData) => {
                  "use server";
                  await switchCompanyAction(String(formData.get("companyId")));
                }}
                style={{ display: "flex", gap: "0.35rem" }}
              >
                <select
                  name="companyId"
                  defaultValue={session.activeCompanyId}
                  className="dvx-input"
                  style={{ fontSize: "0.8rem", width: "auto" }}
                  aria-label="Switch company"
                >
                  {session.memberships.map((m) => (
                    <option key={m.companyId} value={m.companyId}>
                      {m.companyName || m.companySlug}
                    </option>
                  ))}
                </select>
                <button
                  className="dvx-button dvx-button--secondary"
                  type="submit"
                  style={{ fontSize: "0.8rem" }}
                >
                  Switch
                </button>
              </form>
            ) : null}

            <NotificationBell
              totalUnreadCustomerMessages={notificationSummary.totalUnreadCustomerMessages}
              unreadConversations={notificationSummary.unreadConversations}
              pendingHandoverRequests={pendingHandoverRequests}
              unassignedHandovers={unassignedHandovers}
            />

            <details className="dvx-user-menu">
              <summary>
                <Avatar label={session.email ?? "?"} size={32} />
                <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                  <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>{roleLabel}</span>
                  <span className="dvx-muted" style={{ fontSize: "0.72rem" }}>
                    {activeCompanyName}
                  </span>
                </span>
                <ChevronDownIcon />
              </summary>
              <div className="dvx-user-menu-panel">
                <div
                  className="dvx-muted"
                  style={{
                    fontSize: "0.78rem",
                    marginBottom: "0.6rem",
                    overflowWrap: "break-word",
                  }}
                >
                  {session.email}
                </div>
                <form action={logoutAction}>
                  <button
                    className="dvx-button"
                    type="submit"
                    style={{ width: "100%", fontSize: "0.85rem" }}
                  >
                    Sign out
                  </button>
                </form>
              </div>
            </details>
          </div>
        </header>

        <main
          id="dvx-main-content"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            padding: "1.5rem",
            display: "flex",
            flexDirection: "column",
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
