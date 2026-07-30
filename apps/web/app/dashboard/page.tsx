import { platformBrand } from "@dravonix/config";

/**
 * Overview dashboard. Stat values are placeholders (this session has no live
 * database connection); the intended data source for each card is noted so
 * wiring is a matter of calling the corresponding apps/api route once
 * deployed, not a design decision.
 */
const STAT_CARDS = [
  { label: "Active conversations", value: "—", source: "conversations where state != closed" },
  { label: "New leads (7d)", value: "—", source: "leads created_at >= now() - 7d" },
  { label: "Human handovers (7d)", value: "—", source: "conversations where state = human_active" },
  {
    label: "Messages this period",
    value: "—",
    source: "usage_summaries: whatsapp_inbound/outbound",
  },
];

export default function DashboardOverviewPage() {
  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "0.25rem" }}>Overview</h1>
      <p className="dvx-muted" style={{ marginTop: 0 }}>
        {platformBrand.productName} — Dravonix Media (demo tenant)
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          marginTop: "1.5rem",
        }}
      >
        {STAT_CARDS.map((card) => (
          <div key={card.label} className="dvx-card">
            <div className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              {card.label}
            </div>
            <div style={{ fontSize: "1.8rem", fontWeight: 700, marginTop: "0.25rem" }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>WhatsApp connection</div>
        <span className="dvx-badge">Not connected (Stage A: awaiting Meta test number)</span>
        <p className="dvx-muted" style={{ fontSize: "0.85rem", marginTop: "0.75rem" }}>
          Connect the Meta WhatsApp Cloud API test number in Settings → WhatsApp, or via the
          super-admin dashboard. See META_TEST_NUMBER_SETUP.md.
        </p>
      </div>
    </div>
  );
}
