import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Team Settings (app/dashboard/team/page.tsx) -- static source assertions,
 * same pattern as settingsPageCleanup.test.ts (see that file's note on why
 * this can't import the page directly).
 *
 * Phase 2 role model expansion (migration 24) revives team.manage for
 * company_owner/company_admin -- Client Dashboard Permission Hardening
 * (migration 00000000000022) had reduced this page to view +
 * display-name-edit only; these tests assert the revived invite/role-change/
 * deactivate-reactivate/invitation controls are gated on
 * capabilities.canManageTeam (never a hardcoded role string), and that the
 * current company_owner row never gets one of those controls (server-side
 * owner protection, but the UI must stay honest about it too).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const source = readFileSync(join(webRoot, "app/dashboard/team/page.tsx"), "utf8");

describe("Team Settings page", () => {
  it("has the exact required heading", () => {
    expect(source).toContain(">Team Settings<");
  });

  it("is gated behind capabilities.canViewTeam, never a hardcoded email or role", () => {
    expect(source).toContain("capabilities.canViewTeam");
    expect(source).not.toMatch(/["'][\w.+-]+@[\w.-]+\.\w+["']/);
    expect(source).not.toMatch(/role\s*===?\s*["']Admin["']/);
  });

  it("queries company_members scoped to the caller's own session-derived company_id, never a client-supplied id", () => {
    expect(source).toMatch(
      /from\("company_members"\)[\s\S]{0,150}?\.eq\("company_id",\s*session\.activeCompanyId\)/,
    );
  });

  it("never accepts a companyId parameter on the page's own exported function", () => {
    const signatureMatch = source.match(
      /export default async function TeamSettingsPage\(([^)]*)\)/,
    );
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch?.[1] ?? "").toBe("");
  });

  it("never renders Company Settings content -- no company profile, timezone, currency, subscription, or WhatsApp fields", () => {
    for (const forbidden of [
      "Business Timezone",
      "Business Currency",
      "TimezoneCombobox",
      "CurrencySelect",
      "Subscription status",
      "WhatsApp connection",
      "Company name",
      "Admin email",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("never queries the companies table -- this page has no company-configuration data path", () => {
    expect(source).not.toContain('.from("companies")');
  });

  it("gates invite/role-change/deactivate/reactivate/invitation controls on capabilities.canManageTeam", () => {
    for (const required of [
      "InviteMemberForm",
      "InvitationActions",
      "companyChangeMemberRoleAction",
      "companyDeactivateMemberAction",
      "companyReactivateMemberAction",
    ]) {
      expect(source).toContain(required);
    }
    expect(source).toContain("capabilities.canManageTeam");
  });

  it("never lets the client role-change control offer company_owner as a target role", () => {
    expect(source).toContain("CLIENT_ASSIGNABLE_ROLES");
  });

  it("never renders a role-change or deactivate control for the current company_owner row", () => {
    expect(source).toMatch(/isOwner\s*=\s*member\.role\s*===\s*["']company_owner["']/);
    expect(source).toMatch(/canManageTeam[\s\S]{0,40}!isOwner/);
  });

  it("queries company_invitations only for canManageTeam holders, scoped to the caller's own company", () => {
    expect(source).toContain('.from("company_invitations")');
    expect(source).toMatch(/capabilities\.canManageTeam[\s\S]{0,80}from\("company_invitations"\)/);
  });

  it("renders the display-name edit control only for canManageDisplayNames holders", () => {
    expect(source).toContain("capabilities.canManageDisplayNames");
    expect(source).toContain("EditDisplayNameControl");
    expect(source).toContain("updateMemberDisplayNameAction");
  });

  it("shows role and active/inactive status for each member using the shared role-label module", () => {
    expect(source).toContain("companyRoleLabel");
    expect(source).toContain("member.is_active");
    expect(source).toContain('dvx-badge--success" : "dvx-badge--neutral');
  });

  it("uses a responsive row layout (wraps at narrow widths) rather than a fixed desktop-only table", () => {
    expect(source).not.toContain("<table");
    expect(source).toContain("dvx-team-member-row");
  });
});
