export default function LeadsPage() {
  return (
    <div>
      <h1 style={{ fontSize: "1.4rem" }}>Leads</h1>
      <p className="dvx-muted">
        Leads collected by the AI chatbot (customer name, service interest, budget, timeline, etc.)
        will appear here, backed by the <code>leads</code>/<code>lead_events</code> tables.
      </p>
      <div className="dvx-card" style={{ marginTop: "1rem" }}>
        <p className="dvx-muted" style={{ margin: 0 }}>
          No leads yet.
        </p>
      </div>
    </div>
  );
}
