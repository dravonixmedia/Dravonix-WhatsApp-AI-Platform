/**
 * Shown for a lead that is missing, belongs to another company, or is
 * hidden by RLS -- getLead() returns null for every one of those cases, so
 * this page never reveals which one actually happened.
 */
export default function LeadNotFound() {
  return (
    <div className="dvx-card" style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Lead unavailable</h1>
      <p className="dvx-muted" style={{ margin: 0 }}>
        This lead doesn&apos;t exist, isn&apos;t part of your current company, or you no longer have
        access to it.
      </p>
    </div>
  );
}
