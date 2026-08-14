"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Phase 1 built only "Dashboard" (/admin) as a real destination; every other
 * item was a visual placeholder. This pass wires up every route this turn
 * actually implements -- Companies, Users & Roles, Plans, Subscriptions,
 * Entitlements, Usage, Audit Logs, Support Access. Research and Settings
 * remain placeholders: neither was part of this turn's scope, and linking to
 * a route with no real page behind it would be exactly the "fake
 * functionality" this project's Super Admin instructions repeatedly warn
 * against.
 */
const NAV_ITEMS = [
  { label: "Dashboard", href: "/admin" },
  { label: "Companies", href: "/admin/companies" },
  { label: "Users & Roles", href: "/admin/users" },
  { label: "Plans", href: "/admin/plans" },
  { label: "Subscriptions", href: "/admin/subscriptions" },
  { label: "Entitlements", href: "/admin/entitlements" },
  { label: "Usage", href: "/admin/usage" },
  { label: "Audit Logs", href: "/admin/audit" },
  { label: "Support Access", href: "/admin/support-access" },
] as const;

const PLACEHOLDER_ITEMS = ["Research", "Settings"] as const;

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <nav className="dvx-nav-rail" aria-label="Super Admin">
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.href === "/admin" ? pathname === "/admin" : pathname?.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`dvx-nav-link dvx-nav-card${isActive ? " dvx-nav-link--active" : ""}`}
          >
            <span className="dvx-nav-card-label">{item.label}</span>
          </Link>
        );
      })}
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
