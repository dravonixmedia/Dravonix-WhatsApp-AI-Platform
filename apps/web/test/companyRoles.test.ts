import { describe, expect, it } from "vitest";
import {
  ACTIVE_COMPANY_ROLES,
  CLIENT_ASSIGNABLE_ROLES,
  companyRoleLabel,
  isActiveCompanyRole,
  isClientAssignableRole,
} from "../lib/companyRoles.js";

describe("companyRoles", () => {
  it("ACTIVE_COMPANY_ROLES is exactly the six-role Phase 2 model", () => {
    expect([...ACTIVE_COMPANY_ROLES].sort()).toEqual(
      [
        "company_owner",
        "company_admin",
        "manager",
        "team_leader",
        "sales_person",
        "company_accounts",
      ].sort(),
    );
  });

  it("CLIENT_ASSIGNABLE_ROLES is every active role except company_owner", () => {
    expect(CLIENT_ASSIGNABLE_ROLES).not.toContain("company_owner");
    expect([...CLIENT_ASSIGNABLE_ROLES].sort()).toEqual(
      ["company_admin", "manager", "team_leader", "sales_person", "company_accounts"].sort(),
    );
  });

  it("isClientAssignableRole rejects company_owner and every legacy role", () => {
    expect(isClientAssignableRole("company_owner")).toBe(false);
    for (const legacy of ["agent", "knowledge_editor", "billing_viewer", "viewer"]) {
      expect(isClientAssignableRole(legacy)).toBe(false);
    }
    expect(isClientAssignableRole("manager")).toBe(true);
  });

  it("isActiveCompanyRole accepts the six active roles and rejects legacy/garbage values", () => {
    for (const role of ACTIVE_COMPANY_ROLES) {
      expect(isActiveCompanyRole(role)).toBe(true);
    }
    for (const legacy of ["agent", "knowledge_editor", "billing_viewer", "viewer", "bogus"]) {
      expect(isActiveCompanyRole(legacy)).toBe(false);
    }
  });

  it("companyRoleLabel returns a human-readable label for every active role and a legacy-marked label for dormant ones", () => {
    expect(companyRoleLabel("company_owner")).toBe("Owner");
    expect(companyRoleLabel("team_leader")).toBe("Team Leader");
    expect(companyRoleLabel("sales_person")).toBe("Sales Person");
    expect(companyRoleLabel("company_accounts")).toBe("Company Accounts");
    expect(companyRoleLabel("agent")).toContain("legacy");
    expect(companyRoleLabel("viewer")).toContain("legacy");
  });

  it("companyRoleLabel never throws on an unknown value -- falls back to a spaced-out version of the raw string", () => {
    expect(companyRoleLabel("something_unexpected")).toBe("something unexpected");
  });
});
