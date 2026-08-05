/**
 * Automatic Next.js route-segment loading UI (shown while any /dashboard/*
 * page's async Server Component is still fetching) -- generic on purpose,
 * since it can't know in advance which page is loading.
 */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="dvx-skeleton" style={{ width: 180, height: 24, marginBottom: "1.5rem" }} />
      <div className="dvx-kpi-grid">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="dvx-card">
            <div
              className="dvx-skeleton"
              style={{ width: 38, height: 38, borderRadius: 10, marginBottom: "0.6rem" }}
            />
            <div
              className="dvx-skeleton"
              style={{ width: 60, height: 28, marginBottom: "0.4rem" }}
            />
            <div className="dvx-skeleton" style={{ width: 120, height: 14 }} />
          </div>
        ))}
      </div>
      <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="dvx-skeleton" style={{ height: 64, borderRadius: 10 }} />
        ))}
      </div>
    </div>
  );
}
