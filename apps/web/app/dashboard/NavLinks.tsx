"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavLinkItem {
  href: string;
  label: string;
  icon: React.ReactNode;
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
  handover,
  handoverBadgeCount,
}: {
  items: NavLinkItem[];
  handover: NavLinkItem;
  handoverBadgeCount: number;
}) {
  const pathname = usePathname();

  return (
    <nav className="dvx-nav-rail">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isActive(pathname, item.href) ? "page" : undefined}
          className={`dvx-nav-link${isActive(pathname, item.href) ? " dvx-nav-link--active" : ""}`}
        >
          {item.icon}
          <span>{item.label}</span>
        </Link>
      ))}
      <Link
        href={handover.href}
        aria-current={isActive(pathname, handover.href) ? "page" : undefined}
        className={`dvx-nav-link${isActive(pathname, handover.href) ? " dvx-nav-link--active" : ""}`}
      >
        {handover.icon}
        <span>{handover.label}</span>
        {handoverBadgeCount > 0 ? (
          <span className="dvx-nav-badge">{handoverBadgeCount}</span>
        ) : null}
      </Link>
    </nav>
  );
}
