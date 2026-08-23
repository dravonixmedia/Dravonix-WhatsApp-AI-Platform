import { handoverItemNeedsAttention, SupabaseHandoverRepository } from "@dravonix/handover";
import { getDashboardCapabilities } from "../../lib/permissions.js";
import { logoutAction } from "../../lib/actions/auth.js";
import { switchCompanyAction } from "../../lib/actions/company.js";
import { resolveMemberIdentity } from "../../lib/memberIdentity.js";
import { RealtimeRefreshBoundary } from "../../lib/realtime/RealtimeRefreshBoundary.js";
import { DASHBOARD_SHELL_WATCHES } from "../../lib/realtime/watchConfigs.js";
import { loadNotificationSummary } from "../../lib/repositories/notificationsRepository.js";
import { getDashboardSession, NoCompanyAccessError } from "../../lib/session.js";
import { createServerSupabaseClient } from "../../lib/supabase/server.js";
import { BrandIcon, BrandLogo } from "../BrandLogo.js";
import { Avatar } from "./Avatar.js";
import { GlobalSearch } from "./GlobalSearch.js";
import {
  BellIcon,
  ChevronDownIcon,
  ConversationsIcon,
  HandoverIcon,
  LeadsIcon,
  OverviewIcon,
  SearchIcon,
  SettingsIcon,
  WhatsAppIcon,
} from "./Icons.js";
import { NavLinks, type SidebarNavEntry } from "./NavLinks.js";
import { NotificationBell } from "./NotificationBell.js";
import { NotificationPanelProvider } from "./NotificationPanelContext.js";

// Every /dashboard/* route depends on the request's session cookie (real
// Supabase Auth, Human Handover Inbox final plan section 15) -- never
// statically prerenderable, and forcing this explicitly (rather than relying
// on Next's automatic dynamic-API detection) keeps a build from crashing when
// SUPABASE_URL/SUPABASE_ANON_KEY aren't configured (e.g. in CI, which never
// sets real provider secrets by design -- see .github/workflows/ci.yml).
export const dynamic = "force-dynamic";

/**
 * Nav is built per-request from the caller's real, permission-derived
 * capabilities -- never a hardcoded email or role string. Order is fixed by
 * the approved sidebar design (final dashboard UI/UX polish phase): Overview,
 * Live Conversations, Human Handover, Leads, Notifications, DRAIVA, Team
 * Settings, Company Settings, WhatsApp Connection.
 *
 * AI Settings (canViewAiSettings) and Knowledge Base (canViewKnowledge) are
 * real, client-ready dashboard destinations added during the client
 * onboarding foundation pass -- see app/dashboard/ai-settings/page.tsx and
 * app/dashboard/knowledge/page.tsx. Setup Checklist is unconditional (every
 * dashboard user can see their own onboarding progress). Billing is still
 * omitted: it has no client-ready subscription system yet (its route
 * redirects to Settings, which shows the real plan/subscription state
 * instead -- see app/dashboard/billing/page.tsx).
 *
 * The former single "Settings" entry is split into two nav cards pointing at
 * two genuinely distinct routes -- Team Settings (/dashboard/team, view +
 * display-name-edit only; requires canViewTeam) and Company Settings
 * (/dashboard/settings, view-only company configuration; requires
 * canViewSettings or canViewBilling). Client Dashboard Permission Hardening
 * (migration 00000000000022) revoked every *.manage permission these used
 * to check (team.manage/settings.manage/billing.manage) from every client
 * role -- team.view/settings.view are new, narrower view permissions held
 * by exactly the same two roles (company_owner/company_admin) that used to
 * hold the *.manage versions, so no role loses or gains sidebar access here.
 * WhatsApp Connection is gated on canViewWhatsapp (view-only) for the same
 * reason -- the page itself has always been read-only; only the permission
 * key it checked has changed.
 *
 * Notifications and DRAIVA are both real, dedicated dashboard destinations
 * (/dashboard/notifications, /dashboard/draiva) -- plain links, like every
 * other item here, not popups or shortcuts (see those routes' own
 * page.tsx for the workspaces themselves). The top-right notification bell
 * is a separate, compact affordance that keeps working unchanged; the
 * sidebar item no longer toggles it. DRAIVA is gated on
 * canReplyToConversations -- the same permission that already controls
 * whether ConversationComposerWithAssistant renders the "Ask DRAIVA" entry
 * point at all (see conversations/[conversationId]/page.tsx and
 * handover/[conversationId]/page.tsx), and that /dashboard/draiva's own
 * page.tsx re-checks server-side. Human Handover stays unconditional,
 * matching its pre-existing (RLS-backed) visibility.
 */
export function buildNavItems(
  capabilities: ReturnType<typeof getDashboardCapabilities>,
  badgeCounts: { handover: number; notifications: number },
): SidebarNavEntry[] {
  const entries: SidebarNavEntry[] = [
    { kind: "link", href: "/dashboard", label: "Overview", icon: <OverviewIcon /> },
    {
      kind: "link",
      href: "/dashboard/conversations",
      label: "Live Conversations",
      icon: <ConversationsIcon />,
    },
    {
      kind: "link",
      href: "/dashboard/handover",
      label: "Human Handover",
      icon: <HandoverIcon />,
      badgeCount: badgeCounts.handover,
    },
    { kind: "link", href: "/dashboard/leads", label: "Leads", icon: <LeadsIcon /> },
    {
      kind: "link",
      href: "/dashboard/notifications",
      label: "Notifications",
      icon: <BellIcon size={18} />,
      badgeCount: badgeCounts.notifications,
    },
  ];

  if (capabilities.canReplyToConversations) {
    entries.push({ kind: "draiva", href: "/dashboard/draiva" });
  }

  if (capabilities.canViewAiSettings) {
    entries.push({
      kind: "link",
      href: "/dashboard/ai-settings",
      label: "AI Settings",
      icon: <SettingsIcon />,
    });
  }
  if (capabilities.canViewKnowledge) {
    entries.push({
      kind: "link",
      href: "/dashboard/knowledge",
      label: "Knowledge Base",
      icon: <SettingsIcon />,
    });
  }
  entries.push({
    kind: "link",
    href: "/dashboard/onboarding",
    label: "Setup Checklist",
    icon: <SettingsIcon />,
  });
  if (capabilities.canViewTeam) {
    entries.push({
      kind: "link",
      href: "/dashboard/team",
      label: "Team Settings",
      icon: <SettingsIcon />,
    });
  }
  if (capabilities.canViewSettings || capabilities.canViewBilling) {
    entries.push({
      kind: "link",
      href: "/dashboard/settings",
      label: "Company Settings",
      icon: <SettingsIcon />,
      exact: true,
    });
  }
  if (capabilities.canViewWhatsapp) {
    entries.push({
      kind: "link",
      href: "/dashboard/settings/whatsapp",
      label: "WhatsApp Connection",
      icon: <WhatsAppIcon size={18} />,
    });
  }
  return entries;
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
  const navEntries = buildNavItems(capabilities, {
    handover: handoverBadgeCount,
    notifications: notificationSummary.totalUnreadCustomerMessages,
  });

  const roleLabel = ROLE_LABELS[session.activeRole] ?? session.activeRole;
  const activeCompanyName =
    session.memberships.find((m) => m.companyId === session.activeCompanyId)?.companyName ??
    session.memberships[0]?.companyName ??
    "";
  const ownIdentity = resolveMemberIdentity({
    name: session.displayName,
    email: session.email,
    userId: session.userId,
  });
  return (
    <NotificationPanelProvider>
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
        <aside id="dvx-sidebar-nav" className="dvx-sidebar">
          <div className="dvx-sidebar-panel">
            <div
              style={{
                marginBottom: "1.25rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                flexShrink: 0,
              }}
            >
              <BrandLogo height={26} />
            </div>

            <div
              className="dvx-card"
              style={{
                padding: "0.65rem 0.8rem",
                marginBottom: "1rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.2rem",
                flexShrink: 0,
              }}
            >
              <span
                className="dvx-muted"
                style={{
                  fontSize: "0.68rem",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                Current workspace
              </span>
              <span style={{ fontSize: "0.85rem", fontWeight: 600 }} title={activeCompanyName}>
                {activeCompanyName}
              </span>
              <span
                className="dvx-badge dvx-badge--neutral"
                style={{ alignSelf: "flex-start", marginTop: "0.25rem" }}
              >
                {roleLabel}
              </span>
            </div>

            <div className="dvx-sidebar-nav-scroll">
              <NavLinks entries={navEntries} />
            </div>

            <div
              style={{
                marginTop: "auto",
                paddingTop: "0.85rem",
                borderTop: "1px solid var(--border-default)",
                flexShrink: 0,
              }}
            >
              <div
                className="dvx-muted"
                style={{
                  fontSize: "0.72rem",
                  marginBottom: "0.5rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={session.email ?? undefined}
              >
                {ownIdentity.primary}
              </div>
              <form action={logoutAction}>
                <button
                  className="dvx-button dvx-button--secondary"
                  type="submit"
                  style={{ width: "100%", padding: "0.55rem 1rem", fontSize: "0.85rem" }}
                >
                  Sign out
                </button>
              </form>
            </div>
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
            {/* Mobile-only search toggle: pure CSS (:checked ~ sibling), same
                pattern as the sidebar drawer's #dvx-nav-toggle above -- below
                the collapse breakpoint the full search bar is hidden by
                default and this reveals it as its own row instead of letting
                it overlap the notification bell/profile area. Search
                functionality itself is never removed, only relocated. */}
            <input
              type="checkbox"
              id="dvx-search-toggle"
              className="dvx-topbar-search-toggle-input"
              aria-label="Toggle search"
            />
            <label
              htmlFor="dvx-search-toggle"
              className="dvx-topbar-search-toggle-label"
              aria-hidden="true"
            >
              <SearchIcon size={18} />
            </label>
            <GlobalSearch />

            <div className="dvx-topbar-actions">
              {session.memberships.length > 1 ? (
                <form
                  action={async (formData) => {
                    "use server";
                    await switchCompanyAction(String(formData.get("companyId")));
                  }}
                  className="dvx-company-switcher"
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
                  <Avatar label={ownIdentity.primary} size={32} />
                  <span
                    className="dvx-user-menu-label"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      lineHeight: 1.25,
                      maxWidth: 160,
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.85rem",
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={session.email ?? undefined}
                    >
                      {ownIdentity.primary}
                    </span>
                    <span
                      className="dvx-muted"
                      style={{
                        fontSize: "0.72rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
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
                    {roleLabel} · {session.email}
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
    </NotificationPanelProvider>
  );
}
