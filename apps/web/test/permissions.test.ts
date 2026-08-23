import { describe, expect, it } from "vitest";
import { getDashboardCapabilities, hasPermission } from "../lib/permissions.js";

describe("hasPermission", () => {
  it("returns false for a null role", () => {
    expect(hasPermission(null, "conversations.view")).toBe(false);
  });

  it("viewer cannot reply, assign, or view/edit the team", () => {
    expect(hasPermission("viewer", "conversations.view")).toBe(true);
    expect(hasPermission("viewer", "conversations.reply")).toBe(false);
    expect(hasPermission("viewer", "conversations.assign")).toBe(false);
    expect(hasPermission("viewer", "team.view")).toBe(false);
  });

  it("agent can reply but cannot assign or view the team", () => {
    expect(hasPermission("agent", "conversations.reply")).toBe(true);
    expect(hasPermission("agent", "conversations.assign")).toBe(false);
    expect(hasPermission("agent", "team.view")).toBe(false);
  });

  it("manager can assign and reassign but cannot view the team", () => {
    expect(hasPermission("manager", "conversations.assign")).toBe(true);
    expect(hasPermission("manager", "conversations.reassign")).toBe(true);
    expect(hasPermission("manager", "team.view")).toBe(false);
  });

  it("company_admin and company_owner hold every client-facing permission", () => {
    const allPermissions: Parameters<typeof hasPermission>[1][] = [
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

  it("viewer cannot reply, assign, reassign, reconcile, or view/edit the team", () => {
    const capabilities = getDashboardCapabilities("viewer");
    expect(capabilities.canReplyToConversations).toBe(false);
    expect(capabilities.canAssignConversations).toBe(false);
    expect(capabilities.canReassignConversations).toBe(false);
    expect(capabilities.canReconcileOutbound).toBe(false);
    expect(capabilities.canViewTeam).toBe(false);
    expect(capabilities.canViewSettings).toBe(false);
  });

  it("agent can view leads and reply to conversations but cannot assign or view the team", () => {
    const capabilities = getDashboardCapabilities("agent");
    expect(capabilities.canReplyToConversations).toBe(true);
    expect(capabilities.canViewLeads).toBe(true);
    expect(capabilities.canManageLeads).toBe(true);
    expect(capabilities.canAssignConversations).toBe(false);
    expect(capabilities.canViewTeam).toBe(false);
  });

  it("manager can assign conversations and manage leads but cannot view the team or billing", () => {
    const capabilities = getDashboardCapabilities("manager");
    expect(capabilities.canAssignConversations).toBe(true);
    expect(capabilities.canReassignConversations).toBe(true);
    expect(capabilities.canManageLeads).toBe(true);
    expect(capabilities.canViewTeam).toBe(false);
    expect(capabilities.canViewBilling).toBe(false);
  });

  it("company_owner and company_admin can view the team, settings, and billing, and edit display names -- but hold no *.manage capability for settings/AI/knowledge/WhatsApp/billing", () => {
    for (const role of ["company_owner", "company_admin"] as const) {
      const capabilities = getDashboardCapabilities(role);
      expect(capabilities.canViewTeam).toBe(true);
      expect(capabilities.canManageDisplayNames).toBe(true);
      expect(capabilities.canViewSettings).toBe(true);
      expect(capabilities.canViewBilling).toBe(true);
      expect(capabilities.canViewWhatsapp).toBe(true);
      expect(capabilities.canViewAiSettings).toBe(true);
      expect(capabilities.canViewKnowledge).toBe(true);
      expect(capabilities as unknown as Record<string, unknown>).not.toHaveProperty(
        "canManageTeam",
      );
      expect(capabilities as unknown as Record<string, unknown>).not.toHaveProperty(
        "canManageSettings",
      );
      expect(capabilities as unknown as Record<string, unknown>).not.toHaveProperty(
        "canManageWhatsapp",
      );
      expect(capabilities as unknown as Record<string, unknown>).not.toHaveProperty(
        "canManageAiSettings",
      );
      expect(capabilities as unknown as Record<string, unknown>).not.toHaveProperty(
        "canManageKnowledge",
      );
      expect(capabilities as unknown as Record<string, unknown>).not.toHaveProperty(
        "canManageBilling",
      );
    }
  });

  it("viewer can view AI settings and WhatsApp connection info but cannot edit display names", () => {
    const capabilities = getDashboardCapabilities("viewer");
    expect(capabilities.canViewAiSettings).toBe(true);
    expect(capabilities.canViewWhatsapp).toBe(true);
    expect(capabilities.canManageDisplayNames).toBe(false);
    expect(capabilities.canViewTeam).toBe(false);
  });

  it("agent holds neither ai_settings.view nor whatsapp.view (no settings/WhatsApp visibility)", () => {
    const capabilities = getDashboardCapabilities("agent");
    expect(capabilities.canViewAiSettings).toBe(false);
    expect(capabilities.canViewWhatsapp).toBe(false);
  });

  it("knowledge_editor holds ai_settings.view and knowledge.view but no team/settings visibility", () => {
    const capabilities = getDashboardCapabilities("knowledge_editor");
    expect(capabilities.canViewAiSettings).toBe(true);
    expect(capabilities.canViewKnowledge).toBe(true);
    expect(capabilities.canViewTeam).toBe(false);
    expect(capabilities.canViewSettings).toBe(false);
  });
});
