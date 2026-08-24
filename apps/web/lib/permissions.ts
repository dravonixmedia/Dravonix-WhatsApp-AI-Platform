import type { CompanyRole } from "@dravonix/database";

/**
 * Static mirror of supabase/migrations/00000000000009_permission_matrix.sql's
 * role_permissions table, for UI-only capability checks (show/hide, enable/
 * disable). This is never the authorization boundary -- every mutating action
 * already re-verifies the caller's real, current membership and permission
 * server-side (has_company_permission() inside each SECURITY DEFINER RPC, plus
 * RLS on every read). If this mirror ever drifts from the database, the
 * server-side check still wins; the only consequence of drift here is a
 * button that's wrongly shown/hidden, never a bypassed authorization check.
 */
export type PermissionKey =
  | "ai_settings.view"
  | "audit.view"
  | "billing.view"
  | "conversations.assign"
  | "conversations.close"
  | "conversations.reassign"
  | "conversations.reconcile"
  | "conversations.reply"
  | "conversations.view"
  | "knowledge.view"
  | "leads.manage"
  | "leads.view"
  | "settings.view"
  | "team.display_name.manage"
  | "team.manage"
  | "team.view"
  | "usage.view"
  | "whatsapp.view";

/**
 * Phase 2 role model expansion (migrations 23/24): team.manage is revived
 * for company_owner/company_admin (Client Dashboard Permission Hardening,
 * migration 22, had moved team management to Super Admin-only -- Phase 2
 * restores it to the client Team page, now with owner protection enforced
 * server-side, see the RPC comments in migration 24). conversations.close
 * is new -- split out of conversations.assign so Sales Person (which needs
 * conversations.assign for the existing claim/assignment workflow) is
 * excluded from End Human Assistance/Close Conversation specifically.
 * team_leader/sales_person/company_accounts are new roles; agent/
 * knowledge_editor/billing_viewer/viewer are legacy and dormant -- their
 * entries below exist only so a historical row (if one is ever found)
 * still resolves capabilities correctly, never offered anywhere in active
 * UI (see apps/web/lib/companyRoles.ts).
 */
const ROLE_PERMISSIONS: Record<CompanyRole, ReadonlySet<PermissionKey>> = {
  company_owner: new Set([
    "ai_settings.view",
    "audit.view",
    "billing.view",
    "conversations.assign",
    "conversations.close",
    "conversations.reassign",
    "conversations.reconcile",
    "conversations.reply",
    "conversations.view",
    "knowledge.view",
    "leads.manage",
    "leads.view",
    "settings.view",
    "team.display_name.manage",
    "team.manage",
    "team.view",
    "usage.view",
    "whatsapp.view",
  ]),
  company_admin: new Set([
    "ai_settings.view",
    "audit.view",
    "billing.view",
    "conversations.assign",
    "conversations.close",
    "conversations.reassign",
    "conversations.reconcile",
    "conversations.reply",
    "conversations.view",
    "knowledge.view",
    "leads.manage",
    "leads.view",
    "settings.view",
    "team.display_name.manage",
    "team.manage",
    "team.view",
    "usage.view",
    "whatsapp.view",
  ]),
  manager: new Set([
    "ai_settings.view",
    "conversations.assign",
    "conversations.close",
    "conversations.reassign",
    "conversations.reconcile",
    "conversations.reply",
    "conversations.view",
    "knowledge.view",
    "leads.manage",
    "leads.view",
    "team.view",
    "usage.view",
    "whatsapp.view",
  ]),
  team_leader: new Set([
    "ai_settings.view",
    "conversations.assign",
    "conversations.close",
    "conversations.reply",
    "conversations.view",
    "knowledge.view",
    "leads.manage",
    "leads.view",
    "team.view",
    "whatsapp.view",
  ]),
  sales_person: new Set([
    "ai_settings.view",
    "conversations.assign",
    "conversations.reply",
    "conversations.view",
    "knowledge.view",
    "leads.manage",
    "leads.view",
    "team.view",
  ]),
  company_accounts: new Set(["billing.view", "usage.view"]),
  agent: new Set([
    "conversations.reply",
    "conversations.view",
    "knowledge.view",
    "leads.manage",
    "leads.view",
  ]),
  knowledge_editor: new Set(["ai_settings.view", "knowledge.view"]),
  billing_viewer: new Set(["billing.view"]),
  viewer: new Set([
    "ai_settings.view",
    "conversations.view",
    "knowledge.view",
    "leads.view",
    "usage.view",
    "whatsapp.view",
  ]),
};

/** True if platform staff -- platform roles are never automatically company members; see resolveTenantContext/hasCompanyAccess in @dravonix/tenant for the actual server-side authorization equivalent. */
export function hasPermission(role: CompanyRole | null, permission: PermissionKey): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].has(permission);
}

export interface DashboardCapabilities {
  canViewConversations: boolean;
  canReplyToConversations: boolean;
  canAssignConversations: boolean;
  canReassignConversations: boolean;
  canReconcileOutbound: boolean;
  canCloseConversations: boolean;
  canPauseResumeAi: boolean;
  canViewTeam: boolean;
  canManageTeam: boolean;
  canManageDisplayNames: boolean;
  canViewSettings: boolean;
  canViewWhatsapp: boolean;
  canViewAiSettings: boolean;
  canViewKnowledge: boolean;
  canViewBilling: boolean;
  canViewLeads: boolean;
  canManageLeads: boolean;
  canViewUsage: boolean;
  canViewAudit: boolean;
}

/**
 * The one place dashboard components should ask "can this role do X" --
 * never a raw `role === "company_admin"` check scattered across pages.
 * Pause/Resume AI is gated on conversations.assign, matching exactly what
 * handover_pause_ai/handover_resume_ai check server-side -- unchanged since
 * migration 12, and deliberately NOT touched by Phase 2's
 * conversations.close split. End Human Assistance/Close Conversation are
 * gated on the new canCloseConversations (conversations.close) instead --
 * see migration 24's handover_end_human_assistance/
 * handover_close_conversation, which now check conversations.close, not
 * conversations.assign.
 *
 * Phase 2 role model expansion (migration 24) revives canManageTeam
 * (team.manage) for company_owner/company_admin -- Client Dashboard
 * Permission Hardening (migration 22) had moved all team management to
 * Super Admin-only; the client Team page regains invite/role-change/
 * deactivate controls, now with server-side owner protection (see the RPC
 * comments in migration 24). canManageDisplayNames
 * (team.display_name.manage) remains the separate, narrower capability it
 * already was.
 */
export function getDashboardCapabilities(role: CompanyRole | null): DashboardCapabilities {
  return {
    canViewConversations: hasPermission(role, "conversations.view"),
    canReplyToConversations: hasPermission(role, "conversations.reply"),
    canAssignConversations: hasPermission(role, "conversations.assign"),
    canReassignConversations: hasPermission(role, "conversations.reassign"),
    canReconcileOutbound: hasPermission(role, "conversations.reconcile"),
    canCloseConversations: hasPermission(role, "conversations.close"),
    canPauseResumeAi: hasPermission(role, "conversations.assign"),
    canViewTeam: hasPermission(role, "team.view"),
    canManageTeam: hasPermission(role, "team.manage"),
    canManageDisplayNames: hasPermission(role, "team.display_name.manage"),
    canViewSettings: hasPermission(role, "settings.view"),
    canViewWhatsapp: hasPermission(role, "whatsapp.view"),
    canViewAiSettings: hasPermission(role, "ai_settings.view"),
    canViewKnowledge: hasPermission(role, "knowledge.view"),
    canViewBilling: hasPermission(role, "billing.view"),
    canViewLeads: hasPermission(role, "leads.view"),
    canManageLeads: hasPermission(role, "leads.manage"),
    canViewUsage: hasPermission(role, "usage.view"),
    canViewAudit: hasPermission(role, "audit.view"),
  };
}
