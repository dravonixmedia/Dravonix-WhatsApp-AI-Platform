/**
 * Human-friendly identity for a company member row, shared by the Super
 * Admin "Users & Roles" card and the client Team page so both surfaces
 * resolve the same way rather than duplicating this priority logic. No
 * `display_name`/`full_name` field exists anywhere in this schema yet (see
 * migration 00000000000021_member_identity.sql's own audit note) -- `name`
 * is accepted here so this already matches the required display priority
 * the moment a real name field exists, without another pass through every
 * call site.
 */
export interface MemberIdentitySource {
  name?: string | null;
  email?: string | null;
  userId: string;
}

export interface ResolvedMemberIdentity {
  /** Always shown prominently. */
  primary: string;
  /** Shown secondary/muted, only when a name is also available -- never duplicates `primary`. */
  secondary?: string;
}

/** `User ••1234` -- safe to render; never the full user id. */
function maskUserId(userId: string): string {
  return `User ••${userId.slice(-4)}`;
}

export function resolveMemberIdentity(source: MemberIdentitySource): ResolvedMemberIdentity {
  const name = source.name?.trim();
  if (name) {
    return { primary: name, secondary: source.email?.trim() || undefined };
  }
  const email = source.email?.trim();
  if (email) {
    return { primary: email };
  }
  return { primary: maskUserId(source.userId) };
}
