import Link from "next/link";
import { platformBrand } from "@dravonix/config";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/inbox", label: "Inbox" },
  { href: "/dashboard/leads", label: "Leads" },
  { href: "/dashboard/knowledge", label: "Knowledge Base" },
  { href: "/dashboard/billing", label: "Billing" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          width: 240,
          flexShrink: 0,
          borderRight: "1px solid var(--dravonix-border)",
          padding: "1.5rem 1rem",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: "1.1rem", marginBottom: "0.25rem" }}>
          {platformBrand.dashboard.subheading}
        </div>
        <div className="dvx-muted" style={{ fontSize: "0.75rem", marginBottom: "1.5rem" }}>
          {platformBrand.companyName}
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{
                padding: "0.5rem 0.75rem",
                borderRadius: 8,
                fontSize: "0.9rem",
                textDecoration: "none",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main style={{ flex: 1, padding: "2rem" }}>{children}</main>
    </div>
  );
}
