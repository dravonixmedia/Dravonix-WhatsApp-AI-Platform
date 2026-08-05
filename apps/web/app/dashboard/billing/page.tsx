export default function BillingPage() {
  return (
    <div>
      <h1 style={{ fontSize: "1.4rem" }}>Billing</h1>
      <p className="dvx-muted">
        Subscription status, invoices, and the one-time implementation charge. This page remains
        accessible even if the company is suspended, so billing and payment stay available to
        restore service.
      </p>
      <div className="dvx-card" style={{ marginTop: "1rem" }}>
        <div style={{ fontWeight: 600 }}>Current plan</div>
        <p className="dvx-muted" style={{ marginTop: "0.25rem" }}>
          Starter (trial) — demo tenant
        </p>
      </div>
    </div>
  );
}
