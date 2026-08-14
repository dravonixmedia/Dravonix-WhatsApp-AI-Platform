import { redirect } from "next/navigation";
import { logoutAction } from "../../lib/actions/auth.js";
import { getPlatformSession } from "../../lib/session.js";
import { BrandLogo } from "../BrandLogo.js";
import { AdminSidebar } from "./AdminSidebar.js";

// Every /admin/* route depends on the request's session cookie, exactly like
// /dashboard/* (see app/dashboard/layout.tsx) -- never statically
// prerenderable.
export const dynamic = "force-dynamic";

/**
 * Rendered (HTTP 200, no redirect) for any authenticated user who is not a
 * super_admin -- a real account, just not one with Super Admin access. This
 * mirrors the existing NoCompanyAccessPage pattern in
 * app/dashboard/layout.tsx: the codebase's established way of saying
 * "you're signed in, but this area isn't for you" without a raw framework
 * error page. No Admin UI, no sidebar, no data of any kind is rendered here
 * -- this is the only thing a non-super-admin caller (including every
 * normal DRAIVA customer) can ever see at /admin/*.
 */
function ForbiddenPage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div className="dvx-card" style={{ maxWidth: 440, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Forbidden</h1>
        <p className="dvx-muted" style={{ margin: 0 }}>
          This area is restricted to Dravonix platform staff. Your account does not have Super Admin
          access.
        </p>
      </div>
    </main>
  );
}

/**
 * Server-side gate for the entire /admin/* tree (Super Admin foundation,
 * Phase 1). Deliberately independent of app/dashboard/layout.tsx and
 * getDashboardSession() -- neither is read, changed, or depended on here,
 * so /dashboard's existing authentication flow and company-membership
 * requirement are completely untouched by this file's existence.
 *
 * Authorization happens here, not via navigation visibility: no nested
 * /admin/* page can render before this layout resolves, and
 * getPlatformSession() re-verifies the caller against Supabase Auth
 * (supabase.auth.getUser()) and the platform_members table on every request
 * -- there is no client-side-only check anywhere in this tree.
 *
 * Two distinct rejection paths, matching PlatformSession's own doc comment:
 * - No signed-in user at all -> redirect to /login (same outcome as an
 *   unauthenticated /dashboard/* request).
 * - Signed in but platformRole !== "super_admin" (no platform_members row,
 *   or an active platform_support/platform_billing_admin row -- Phase 1
 *   requires super_admin specifically) -> ForbiddenPage, never a redirect,
 *   since the account itself is real and login would not help.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getPlatformSession();

  if (!session) {
    redirect("/login?redirectedFrom=/admin");
  }

  if (session.platformRole !== "super_admin") {
    return <ForbiddenPage />;
  }

  return (
    <div style={{ display: "flex", height: "100dvh", overflow: "hidden" }}>
      <aside className="dvx-sidebar">
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
              DRAIVA Platform
            </span>
            <span
              className="dvx-badge dvx-badge--neutral"
              style={{ alignSelf: "flex-start", marginTop: "0.25rem" }}
            >
              Super Admin
            </span>
          </div>

          <div className="dvx-sidebar-nav-scroll">
            <AdminSidebar />
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
              {session.email}
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
          overflow: "auto",
        }}
      >
        <main style={{ padding: "2rem", maxWidth: 1100 }}>{children}</main>
      </div>
    </div>
  );
}
