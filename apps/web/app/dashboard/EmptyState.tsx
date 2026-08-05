export function EmptyState({
  icon,
  title,
  description,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="dvx-empty-state">
      {icon ? <span className="dvx-empty-state-icon">{icon}</span> : null}
      <p style={{ fontWeight: 600, color: "var(--text-secondary)", margin: 0 }}>{title}</p>
      {description ? (
        <p className="dvx-muted" style={{ fontSize: "0.85rem", margin: 0, maxWidth: 320 }}>
          {description}
        </p>
      ) : null}
    </div>
  );
}
