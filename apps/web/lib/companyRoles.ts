import type { CompanyRole } from "@dravonix/database";

/**
 * Single source of truth for the Phase 2 active six-role client model
 * (migrations 23/24) -- role values, human-readable labels, and which
 * roles a client/Super Admin may actually assign. Every UI surface that
 * used to keep its own role array/label map (InviteMemberForm, the Super
 * Admin company page, the client Team page, the dashboard shell's role
 * badge, invitation email role labels) now imports from here instead.
 *
 * This module is presentation/validation convenience only -- never the
 * authorization boundary. Every RPC that accepts a role re-validates it
 * server-side (create_company_invitation, company_change_member_role,
 * admin_change_company_member_role, ...); if this list ever drifts from
 * the database, the RPC's own check still wins.
 */

/** The six roles active in the current product -- what Super Admin dropdowns offer. */
export const ACTIVE_COMPANY_ROLES: readonly CompanyRole[] = [
  "company_owner",
  "company_admin",
  "manager",
  "team_leader",
  "sales_person",
  "company_accounts",
];

/**
 * What a client (company_owner/company_admin with team.manage) may invite
 * or change another member's role to -- every active role except
 * company_owner. Mirrors create_company_invitation/
 * company_change_member_role's own server-side allow-list exactly; a
 * client can never assign/promote-to company_owner through the Team page,
 * only through a future Super Admin-only Transfer Ownership workflow.
 */
export const CLIENT_ASSIGNABLE_ROLES: readonly CompanyRole[] = [
  "company_admin",
  "manager",
  "team_leader",
  "sales_person",
  "company_accounts",
];

export const COMPANY_ROLE_LABELS: Record<CompanyRole, string> = {
  company_owner: "Owner",
  company_admin: "Admin",
  manager: "Manager",
  team_leader: "Team Leader",
  sales_person: "Sales Person",
  company_accounts: "Company Accounts",
  // Legacy, dormant roles (migrations 23/24) -- no longer assignable
  // anywhere, kept only so a historical row (if one ever exists) still
  // renders a readable label instead of a raw enum value.
  agent: "Agent (legacy)",
  knowledge_editor: "Knowledge Editor (legacy)",
  billing_viewer: "Billing Viewer (legacy)",
  viewer: "Viewer (legacy)",
};

export function companyRoleLabel(role: string): string {
  return COMPANY_ROLE_LABELS[role as CompanyRole] ?? role.replace(/_/g, " ");
}

export function isClientAssignableRole(value: string): value is CompanyRole {
  return (CLIENT_ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

export function isActiveCompanyRole(value: string): value is CompanyRole {
  return (ACTIVE_COMPANY_ROLES as readonly string[]).includes(value);
}
