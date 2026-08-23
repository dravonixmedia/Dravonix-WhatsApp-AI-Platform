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
  | "conversations.reassign"
  | "conversations.reconcile"
  | "conversations.reply"
  | "conversations.view"
  | "knowledge.view"
  | "leads.manage"
  | "leads.view"
  | "settings.view"
  | "team.display_name.manage"
  | "team.view"
  | "usage.view"
  | "whatsapp.view";

/**
 * Client Dashboard Permission Hardening (migration 00000000000022): every
 * *.manage permission that let a client role write configuration Dravonix
 * now owns exclusively (ai_settings.manage, knowledge.manage,
 * settings.manage, team.manage, whatsapp.manage, billing.manage) has been
 * removed from every company role at the database level -- this mirror
 * reflects that; it is not merely a UI-hiding change. team.view/
 * team.display_name.manage/settings.view are new, narrower permissions:
 * only company_owner/company_admin hold them (the same two roles that used
 * to hold team.manage/settings.manage), so no role gains new visibility it
 * didn't already effectively have.
 */
const ROLE_PERMISSIONS: Record<CompanyRole, ReadonlySet<PermissionKey>> = {
  company_owner: new Set([
    "ai_settings.view",
    "audit.view",
    "billing.view",
    "conversations.assign",
    "conversations.reassign",
    "conversations.reconcile",
    "conversations.reply",
    "conversations.view",
    "knowledge.view",
    "leads.manage",
    "leads.view",
    "settings.view",
    "team.display_name.manage",
    "team.view",
    "usage.view",
    "whatsapp.view",
  ]),
  company_admin: new Set([
    "ai_settings.view",
    "audit.view",
    "billing.view",
    "conversations.assign",
    "conversations.reassign",
    "conversations.reconcile",
    "conversations.reply",
    "conversations.view",
    "knowledge.view",
    "leads.manage",
    "leads.view",
    "settings.view",
    "team.display_name.manage",
    "team.view",
    "usage.view",
    "whatsapp.view",
  ]),
  manager: new Set([
    "ai_settings.view",
    "conversations.assign",
    "conversations.reassign",
    "conversations.reconcile",
    "conversations.reply",
    "conversations.view",
    "knowledge.view",
    "leads.manage",
    "leads.view",
    "usage.view",
    "whatsapp.view",
  ]),
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
  canPauseResumeAi: boolean;
  canViewTeam: boolean;
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
 * Pause/Resume AI and every assignment action are gated on
 * conversations.assign, matching exactly what handover_pause_ai/
 * handover_resume_ai/handover_assign_to_me check server-side in
 * migration 12 -- unchanged by client permission hardening (migration 22),
 * which never touches conversations.assign or any conversation-level
 * permission.
 *
 * Every *.manage capability that used to let a client write company
 * configuration directly (canManageTeam, canManageSettings,
 * canManageWhatsapp, canManageAiSettings, canManageKnowledge,
 * canManageBilling) is gone: that configuration is now Dravonix-only,
 * managed from Super Admin. canManageDisplayNames (team.display_name.manage)
 * is the one narrow write capability clients keep on the Team page.
 */
export function getDashboardCapabilities(role: CompanyRole | null): DashboardCapabilities {
  return {
    canViewConversations: hasPermission(role, "conversations.view"),
    canReplyToConversations: hasPermission(role, "conversations.reply"),
    canAssignConversations: hasPermission(role, "conversations.assign"),
    canReassignConversations: hasPermission(role, "conversations.reassign"),
    canReconcileOutbound: hasPermission(role, "conversations.reconcile"),
    canPauseResumeAi: hasPermission(role, "conversations.assign"),
    canViewTeam: hasPermission(role, "team.view"),
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
