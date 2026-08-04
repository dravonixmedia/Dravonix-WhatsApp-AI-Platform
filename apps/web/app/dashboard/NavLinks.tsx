"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavLinkItem {
  href: string;
  label: string;
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Client component so the sidebar can highlight the current route via
 * usePathname() -- the surrounding DashboardLayout stays a Server Component
 * (session/handover-badge data still loads server-side); only this small
 * nav slice needs client-side route awareness.
 */
export function NavLinks({
  items,
  handoverHref,
  handoverBadgeCount,
}: {
  items: NavLinkItem[];
  handoverHref: string;
  handoverBadgeCount: number;
}) {
  const pathname = usePathname();

  return (
    <nav style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isActive(pathname, item.href) ? "page" : undefined}
          className={`dvx-nav-link${isActive(pathname, item.href) ? " dvx-nav-link--active" : ""}`}
        >
          {item.label}
        </Link>
      ))}
      <Link
        href={handoverHref}
        aria-current={isActive(pathname, handoverHref) ? "page" : undefined}
        className={`dvx-nav-link${isActive(pathname, handoverHref) ? " dvx-nav-link--active" : ""}`}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <span>Human Handover</span>
        {handoverBadgeCount > 0 ? (
          <span
            style={{
              background: "#dc2626",
              color: "white",
              borderRadius: 999,
              fontSize: "0.7rem",
              padding: "0.05rem 0.45rem",
            }}
          >
            {handoverBadgeCount}
          </span>
        ) : null}
      </Link>
    </nav>
  );
}
