import Link from "next/link";

/**
 * Phase 1 foundation only: "Dashboard" is the only real, working destination
 * (/admin). Every other entry is a visual placeholder for a later phase --
 * deliberately NOT a <Link> to a route that doesn't exist yet (that would be
 * a dead link / fake functionality, which this phase explicitly avoids).
 */
const PLACEHOLDER_ITEMS = [
  "Companies",
  "Users & Roles",
  "Plans",
  "Subscriptions",
  "Entitlements",
  "Usage",
  "Research",
  "Audit Logs",
  "Support Access",
  "Settings",
] as const;

export function AdminSidebar() {
  return (
    <nav className="dvx-nav-rail" aria-label="Super Admin">
      <Link href="/admin" className="dvx-nav-link dvx-nav-card dvx-nav-link--active">
        <span className="dvx-nav-card-label">Dashboard</span>
      </Link>
      {PLACEHOLDER_ITEMS.map((label) => (
        <div
          key={label}
          className="dvx-nav-link dvx-nav-card"
          aria-disabled="true"
          style={{ opacity: 0.55, cursor: "default", justifyContent: "space-between" }}
        >
          <span className="dvx-nav-card-label">{label}</span>
          <span
            className="dvx-badge dvx-badge--neutral"
            style={{ fontSize: "0.62rem", padding: "0.1rem 0.4rem" }}
          >
            Soon
          </span>
        </div>
      ))}
    </nav>
  );
}
