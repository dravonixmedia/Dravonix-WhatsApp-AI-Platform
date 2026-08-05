import Link from "next/link";

export interface KpiCardProps {
  label: string;
  value: number;
  href: string;
  icon: React.ReactNode;
  tone?: "brand" | "warning" | "info" | "success";
}

const TONE_STYLES: Record<NonNullable<KpiCardProps["tone"]>, { bg: string; fg: string }> = {
  brand: { bg: "var(--surface-selected)", fg: "var(--brand-cyan)" },
  warning: { bg: "var(--warning-surface)", fg: "var(--warning)" },
  info: { bg: "var(--info-surface)", fg: "var(--info)" },
  success: { bg: "var(--success-surface)", fg: "var(--success)" },
};

/**
 * Overview KPI tile. Every value passed in must come from a real tenant-
 * scoped query (see app/dashboard/page.tsx's loadOverviewCounts) -- this
 * component only formats/presents, it never computes or fabricates a number.
 * No trend delta is rendered: there is no historical snapshot to diff
 * against in the current schema, so showing one would be fake data.
 */
export function KpiCard({ label, value, href, icon, tone = "brand" }: KpiCardProps) {
  const toneStyle = TONE_STYLES[tone];
  return (
    <Link href={href} className="dvx-card dvx-card--interactive dvx-kpi-card">
      <span
        className="dvx-kpi-icon"
        style={{ background: toneStyle.bg, color: toneStyle.fg }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="dvx-kpi-value">{value}</span>
      <span className="dvx-kpi-label">{label}</span>
    </Link>
  );
}
