import { describe, expect, it } from "vitest";
import { getDashboardCapabilities, hasPermission } from "../lib/permissions.js";

describe("hasPermission", () => {
  it("returns false for a null role", () => {
    expect(hasPermission(null, "conversations.view")).toBe(false);
  });

  it("viewer cannot reply, assign, or manage anything", () => {
    expect(hasPermission("viewer", "conversations.view")).toBe(true);
    expect(hasPermission("viewer", "conversations.reply")).toBe(false);
    expect(hasPermission("viewer", "conversations.assign")).toBe(false);
    expect(hasPermission("viewer", "team.manage")).toBe(false);
  });

  it("agent can reply but cannot assign or manage the team", () => {
    expect(hasPermission("agent", "conversations.reply")).toBe(true);
    expect(hasPermission("agent", "conversations.assign")).toBe(false);
    expect(hasPermission("agent", "team.manage")).toBe(false);
  });

  it("manager can assign and reassign but cannot manage the team", () => {
    expect(hasPermission("manager", "conversations.assign")).toBe(true);
    expect(hasPermission("manager", "conversations.reassign")).toBe(true);
    expect(hasPermission("manager", "team.manage")).toBe(false);
  });

  it("company_admin and company_owner hold every permission", () => {
    const allPermissions: Parameters<typeof hasPermission>[1][] = [
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
    ];
    for (const permission of allPermissions) {
      expect(hasPermission("company_admin", permission)).toBe(true);
      expect(hasPermission("company_owner", permission)).toBe(true);
    }
  });

  it("billing_viewer holds only billing.view", () => {
    expect(hasPermission("billing_viewer", "billing.view")).toBe(true);
    expect(hasPermission("billing_viewer", "conversations.view")).toBe(false);
  });
});

describe("getDashboardCapabilities", () => {
  it("returns all-false capabilities for a null role", () => {
    const capabilities = getDashboardCapabilities(null);
    expect(Object.values(capabilities).every((value) => value === false)).toBe(true);
  });

  it("gates Pause/Resume AI on conversations.assign, matching the migration-12 RPC checks", () => {
    expect(getDashboardCapabilities("viewer").canPauseResumeAi).toBe(false);
    expect(getDashboardCapabilities("agent").canPauseResumeAi).toBe(false);
    expect(getDashboardCapabilities("manager").canPauseResumeAi).toBe(true);
    expect(getDashboardCapabilities("company_admin").canPauseResumeAi).toBe(true);
    expect(getDashboardCapabilities("company_owner").canPauseResumeAi).toBe(true);
  });

  it("viewer cannot reply, assign, reassign, reconcile, or manage anything", () => {
    const capabilities = getDashboardCapabilities("viewer");
    expect(capabilities.canReplyToConversations).toBe(false);
    expect(capabilities.canAssignConversations).toBe(false);
    expect(capabilities.canReassignConversations).toBe(false);
    expect(capabilities.canReconcileOutbound).toBe(false);
    expect(capabilities.canManageTeam).toBe(false);
    expect(capabilities.canManageSettings).toBe(false);
  });

  it("agent can view leads and reply to conversations but cannot assign or manage the team", () => {
    const capabilities = getDashboardCapabilities("agent");
    expect(capabilities.canReplyToConversations).toBe(true);
    expect(capabilities.canViewLeads).toBe(true);
    expect(capabilities.canManageLeads).toBe(true);
    expect(capabilities.canAssignConversations).toBe(false);
    expect(capabilities.canManageTeam).toBe(false);
  });

  it("manager can assign conversations and manage leads but cannot manage the team or billing", () => {
    const capabilities = getDashboardCapabilities("manager");
    expect(capabilities.canAssignConversations).toBe(true);
    expect(capabilities.canReassignConversations).toBe(true);
    expect(capabilities.canManageLeads).toBe(true);
    expect(capabilities.canManageTeam).toBe(false);
    expect(capabilities.canManageBilling).toBe(false);
  });

  it("company_owner and company_admin can manage the team, settings, and billing", () => {
    for (const role of ["company_owner", "company_admin"] as const) {
      const capabilities = getDashboardCapabilities(role);
      expect(capabilities.canManageTeam).toBe(true);
      expect(capabilities.canManageSettings).toBe(true);
      expect(capabilities.canManageBilling).toBe(true);
      expect(capabilities.canManageWhatsapp).toBe(true);
      expect(capabilities.canManageAiSettings).toBe(true);
    }
  });
});
