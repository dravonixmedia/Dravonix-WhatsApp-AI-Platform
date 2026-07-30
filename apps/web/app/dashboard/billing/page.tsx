export default function BillingPage() {
  return (
    <div>
      <h1 style={{ fontSize: "1.4rem" }}>Billing</h1>
      <p className="dvx-muted">
        Subscription status, invoices, and the one-time implementation charge, backed by{" "}
        <code>packages/billing</code>&apos;s subscription state machine. This page remains
        accessible even when the company is suspended (Master Prompt section 23) — every other
        dashboard section becomes read-only, but billing and payment stay available so the company
        can restore service.
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
