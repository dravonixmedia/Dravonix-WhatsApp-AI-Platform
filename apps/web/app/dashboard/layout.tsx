import { countHandoverBadge, SupabaseHandoverRepository } from "@dravonix/handover";
import { platformBrand } from "@dravonix/config";
import { logoutAction } from "../../lib/actions/auth.js";
import { switchCompanyAction } from "../../lib/actions/company.js";
import { getDashboardSession, NoCompanyAccessError } from "../../lib/session.js";
import { createServerSupabaseClient } from "../../lib/supabase/server.js";
import { NavLinks } from "./NavLinks.js";

// Every /dashboard/* route depends on the request's session cookie (real
// Supabase Auth, Human Handover Inbox final plan section 15) -- never
// statically prerenderable, and forcing this explicitly (rather than relying
// on Next's automatic dynamic-API detection) keeps a build from crashing when
// SUPABASE_URL/SUPABASE_ANON_KEY aren't configured (e.g. in CI, which never
// sets real provider secrets by design -- see .github/workflows/ci.yml).
export const dynamic = "force-dynamic";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/conversations", label: "Live Conversations" },
  { href: "/dashboard/leads", label: "Leads" },
  { href: "/dashboard/knowledge", label: "Knowledge Base" },
  { href: "/dashboard/billing", label: "Billing" },
  { href: "/dashboard/settings", label: "Settings" },
];

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
        minHeight: "100vh",
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
  const handoverBadgeCount = await countHandoverBadge(
    new SupabaseHandoverRepository(supabase),
    session.activeCompanyId,
  );

  const roleLabel = ROLE_LABELS[session.activeRole] ?? session.activeRole;

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <input
        type="checkbox"
        id="dvx-nav-toggle"
        className="dvx-nav-toggle-input"
        aria-label="Toggle navigation menu"
      />
      <label htmlFor="dvx-nav-toggle" className="dvx-nav-toggle-label" aria-hidden="true">
        <span />
        <span />
        <span />
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
          background: "var(--surface-elevated)",
          borderRight: "1px solid var(--border-default)",
          padding: "1.5rem 1rem",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: "1.1rem", marginBottom: "0.25rem" }}>
          {platformBrand.dashboard.subheading}
        </div>
        <div className="dvx-muted" style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
          {platformBrand.companyName}
        </div>
        <span
          className="dvx-badge dvx-badge--neutral"
          style={{ alignSelf: "flex-start", marginBottom: "1rem" }}
        >
          {roleLabel}
        </span>

        {session.memberships.length > 1 ? (
          <form
            action={async (formData) => {
              "use server";
              await switchCompanyAction(String(formData.get("companyId")));
            }}
            style={{
              marginBottom: "1rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
            }}
          >
            <select
              name="companyId"
              defaultValue={session.activeCompanyId}
              className="dvx-input"
              title={
                session.memberships.find((m) => m.companyId === session.activeCompanyId)
                  ?.companyName ?? undefined
              }
              style={{ fontSize: "0.85rem" }}
            >
              {session.memberships.map((m) => (
                <option key={m.companyId} value={m.companyId}>
                  {m.companyName || m.companySlug}
                </option>
              ))}
            </select>
            <button
              className="dvx-button"
              type="submit"
              style={{ fontSize: "0.8rem", width: "100%" }}
            >
              Switch company
            </button>
          </form>
        ) : (
          <div className="dvx-muted" style={{ fontSize: "0.8rem", marginBottom: "1rem" }}>
            {session.memberships[0]?.companyName}
          </div>
        )}

        <NavLinks
          items={NAV_ITEMS}
          handoverHref="/dashboard/handover"
          handoverBadgeCount={handoverBadgeCount}
        />

        <div style={{ marginTop: "auto", paddingTop: "1rem" }}>
          <div className="dvx-muted" style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
            {session.email}
          </div>
          <form action={logoutAction}>
            <button className="dvx-button" type="submit" style={{ width: "100%" }}>
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main id="dvx-main-content" style={{ flex: 1, padding: "2rem", minWidth: 0 }}>
        {children}
      </main>
    </div>
  );
}
