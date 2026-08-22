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
  | "ai_settings.manage"
  | "ai_settings.view"
  | "audit.view"
  | "billing.manage"
  | "billing.view"
  | "conversations.assign"
  | "conversations.reassign"
  | "conversations.reconcile"
  | "conversations.reply"
  | "conversations.view"
  | "knowledge.manage"
  | "knowledge.view"
  | "leads.manage"
  | "leads.view"
  | "settings.manage"
  | "team.manage"
  | "usage.view"
  | "whatsapp.manage"
  | "whatsapp.view";

const ROLE_PERMISSIONS: Record<CompanyRole, ReadonlySet<PermissionKey>> = {
  company_owner: new Set([
    "ai_settings.manage",
    "ai_settings.view",
    "audit.view",
    "billing.manage",
    "billing.view",
    "conversations.assign",
    "conversations.reassign",
    "conversations.reconcile",
    "conversations.reply",
    "conversations.view",
    "knowledge.manage",
    "knowledge.view",
    "leads.manage",
    "leads.view",
    "settings.manage",
    "team.manage",
    "usage.view",
    "whatsapp.manage",
    "whatsapp.view",
  ]),
  company_admin: new Set([
    "ai_settings.manage",
    "ai_settings.view",
    "audit.view",
    "billing.manage",
    "billing.view",
    "conversations.assign",
    "conversations.reassign",
    "conversations.reconcile",
    "conversations.reply",
    "conversations.view",
    "knowledge.manage",
    "knowledge.view",
    "leads.manage",
    "leads.view",
    "settings.manage",
    "team.manage",
    "usage.view",
    "whatsapp.manage",
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
  knowledge_editor: new Set(["ai_settings.view", "knowledge.manage", "knowledge.view"]),
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
  canManageTeam: boolean;
  canManageSettings: boolean;
  canManageWhatsapp: boolean;
  canViewWhatsapp: boolean;
  canManageAiSettings: boolean;
  canViewAiSettings: boolean;
  canViewKnowledge: boolean;
  canManageKnowledge: boolean;
  canViewBilling: boolean;
  canManageBilling: boolean;
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
 * migration 12.
 */
export function getDashboardCapabilities(role: CompanyRole | null): DashboardCapabilities {
  return {
    canViewConversations: hasPermission(role, "conversations.view"),
    canReplyToConversations: hasPermission(role, "conversations.reply"),
    canAssignConversations: hasPermission(role, "conversations.assign"),
    canReassignConversations: hasPermission(role, "conversations.reassign"),
    canReconcileOutbound: hasPermission(role, "conversations.reconcile"),
    canPauseResumeAi: hasPermission(role, "conversations.assign"),
    canManageTeam: hasPermission(role, "team.manage"),
    canManageSettings: hasPermission(role, "settings.manage"),
    canManageWhatsapp: hasPermission(role, "whatsapp.manage"),
    canViewWhatsapp: hasPermission(role, "whatsapp.view"),
    canManageAiSettings: hasPermission(role, "ai_settings.manage"),
    canViewAiSettings: hasPermission(role, "ai_settings.view"),
    canViewKnowledge: hasPermission(role, "knowledge.view"),
    canManageKnowledge: hasPermission(role, "knowledge.manage"),
    canViewBilling: hasPermission(role, "billing.view"),
    canManageBilling: hasPermission(role, "billing.manage"),
    canViewLeads: hasPermission(role, "leads.view"),
    canManageLeads: hasPermission(role, "leads.manage"),
    canViewUsage: hasPermission(role, "usage.view"),
    canViewAudit: hasPermission(role, "audit.view"),
  };
}
