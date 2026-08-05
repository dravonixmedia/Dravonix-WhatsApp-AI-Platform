/**
 * Initials avatar derived from real session data (name or email) -- no
 * profile-photo field exists anywhere in the data model, so this is never a
 * placeholder image, just a deterministic rendering of a real identifier.
 */
export function initialsFor(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return "?";
  const atIndex = trimmed.indexOf("@");
  const namePart = atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
  const parts = namePart.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return namePart.slice(0, 2).toUpperCase();
}

export function Avatar({ label, size = 32 }: { label: string; size?: number }) {
  return (
    <span
      className="dvx-avatar"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {initialsFor(label)}
    </span>
  );
}
