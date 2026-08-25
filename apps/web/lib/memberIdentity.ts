/**
 * Human-friendly identity for a company member row, shared by the Super
 * Admin "Users & Roles" card and the client Team page so both surfaces
 * resolve the same way rather than duplicating this priority logic. The
 * `name` field is the editable `user_profiles.display_name` introduced by
 * migration 00000000000021_member_identity.sql, resolved via
 * list_company_member_identities alongside email -- absent until a user or
 * an authorized admin sets one, in which case email remains the primary
 * identity.
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

/** One row of `list_company_member_identities`'s result shape. */
export interface CompanyMemberIdentityRow {
  member_id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
}

/**
 * Indexes `list_company_member_identities` rows by `user_id` rather than
 * `member_id` -- for call sites (Support & Requests, Audit Logs) that only
 * have a bare auth user id to resolve, not a company_members row. Shared so
 * every such call site batches the same one RPC call per company rather than
 * re-deriving this index inline.
 */
export function buildMemberIdentityByUserId(
  rows: CompanyMemberIdentityRow[],
): Map<string, { email: string | null; displayName: string | null }> {
  return new Map(
    rows.map((row) => [row.user_id, { email: row.email, displayName: row.display_name }]),
  );
}
