import { PermissionDeniedError, TenantIsolationViolationError } from "@dravonix/core";
import { describe, expect, it } from "vitest";
import {
  assertResourceBelongsToCompany,
  hasCompanyAccess,
  requirePermission,
  resolveTenantContext,
  type CompanyMembership,
  type MembershipRepository,
} from "../src/context.js";

const COMPANY_A = "aaaaaaaa-0000-0000-0000-000000000001";
const COMPANY_B = "bbbbbbbb-0000-0000-0000-000000000002";

class FakeMembershipRepository implements MembershipRepository {
  constructor(
    private readonly memberships: Record<string, CompanyMembership>,
    private readonly platformRoles: Record<
      string,
      "super_admin" | "platform_support" | "platform_billing_admin"
    > = {},
  ) {}

  async getActiveMembership(userId: string, companyId: string): Promise<CompanyMembership | null> {
    const membership = this.memberships[userId];
    if (!membership || membership.companyId !== companyId) return null;
    return membership;
  }

  async getPlatformRole(userId: string) {
    return this.platformRoles[userId] ?? null;
  }
}

describe("resolveTenantContext", () => {
  it("resolves an active company membership", async () => {
    const repo = new FakeMembershipRepository({
      "user-1": {
        companyId: COMPANY_A,
        role: "agent",
        permissions: new Set(["conversations.view"]),
      },
    });

    const context = await resolveTenantContext(repo, { userId: "user-1", companyId: COMPANY_A });

    expect(context.membership?.companyId).toBe(COMPANY_A);
    expect(context.membership?.role).toBe("agent");
    expect(context.platformRole).toBeNull();
  });

  it("returns null membership for a user with no active membership in that company", async () => {
    const repo = new FakeMembershipRepository({});
    const context = await resolveTenantContext(repo, { userId: "ghost", companyId: COMPANY_A });
    expect(context.membership).toBeNull();
  });
});

describe("hasCompanyAccess", () => {
  it("grants access to a member of the same company", () => {
    const context = {
      userId: "user-1",
      membership: { companyId: COMPANY_A, role: "agent" as const, permissions: new Set<string>() },
      platformRole: null,
    };
    expect(hasCompanyAccess(context, COMPANY_A)).toBe(true);
    expect(hasCompanyAccess(context, COMPANY_B)).toBe(false);
  });

  it("grants platform staff access to any company", () => {
    const context = {
      userId: "staff-1",
      membership: null,
      platformRole: "platform_support" as const,
    };
    expect(hasCompanyAccess(context, COMPANY_A)).toBe(true);
    expect(hasCompanyAccess(context, COMPANY_B)).toBe(true);
  });
});

describe("requirePermission", () => {
  it("passes when the member holds the permission", () => {
    const context = {
      userId: "user-1",
      membership: {
        companyId: COMPANY_A,
        role: "agent" as const,
        permissions: new Set(["conversations.reply"]),
      },
      platformRole: null,
    };
    expect(() => requirePermission(context, COMPANY_A, "conversations.reply")).not.toThrow();
  });

  it("throws PermissionDeniedError when the member lacks the permission", () => {
    const context = {
      userId: "user-1",
      membership: {
        companyId: COMPANY_A,
        role: "billing_viewer" as const,
        permissions: new Set(["billing.view"]),
      },
      platformRole: null,
    };
    expect(() => requirePermission(context, COMPANY_A, "conversations.view")).toThrow(
      PermissionDeniedError,
    );
  });

  it("throws TenantIsolationViolationError when the member belongs to a different company", () => {
    const context = {
      userId: "user-1",
      membership: {
        companyId: COMPANY_B,
        role: "company_owner" as const,
        permissions: new Set(["conversations.view"]),
      },
      platformRole: null,
    };
    expect(() => requirePermission(context, COMPANY_A, "conversations.view")).toThrow(
      TenantIsolationViolationError,
    );
  });

  it("allows platform staff regardless of permission set", () => {
    const context = { userId: "staff-1", membership: null, platformRole: "super_admin" as const };
    expect(() => requirePermission(context, COMPANY_A, "billing.manage")).not.toThrow();
  });
});

describe("assertResourceBelongsToCompany", () => {
  it("throws when a resource belongs to a different company than the context", () => {
    const context = {
      userId: "user-1",
      membership: { companyId: COMPANY_A, role: "agent" as const, permissions: new Set<string>() },
      platformRole: null,
    };
    expect(() => assertResourceBelongsToCompany(context, COMPANY_B)).toThrow(
      TenantIsolationViolationError,
    );
  });

  it("does not throw when the resource belongs to the context's company", () => {
    const context = {
      userId: "user-1",
      membership: { companyId: COMPANY_A, role: "agent" as const, permissions: new Set<string>() },
      platformRole: null,
    };
    expect(() => assertResourceBelongsToCompany(context, COMPANY_A)).not.toThrow();
  });
});
