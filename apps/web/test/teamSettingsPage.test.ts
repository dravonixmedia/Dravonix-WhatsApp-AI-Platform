import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Team Settings (app/dashboard/team/page.tsx) -- static source assertions,
 * same pattern as settingsPageCleanup.test.ts (see that file's note on why
 * this can't import the page directly).
 *
 * Client Dashboard Permission Hardening (migration 00000000000022) reduced
 * this page to view + display-name-edit only: team.manage was revoked from
 * every client role at the database level, so invite/resend/revoke/
 * change-role/deactivate are no longer reachable by any client session --
 * these tests assert the page's UI matches that, not merely that a
 * capability flag is checked.
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

  it("does not render invite, resend, revoke, change-role, or deactivate controls -- those are Dravonix-only now", () => {
    for (const forbidden of [
      "InviteMemberForm",
      "InvitationActions",
      "companyChangeMemberRoleAction",
      "companyDeactivateMemberAction",
      "createCompanyInvitationAction",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("never queries company_invitations -- there is no invitation data path on this page", () => {
    expect(source).not.toContain('.from("company_invitations")');
  });

  it("renders the display-name edit control only for canManageDisplayNames holders", () => {
    expect(source).toContain("capabilities.canManageDisplayNames");
    expect(source).toContain("EditDisplayNameControl");
    expect(source).toContain("updateMemberDisplayNameAction");
  });

  it("shows role and active/inactive status for each member, same real data as before", () => {
    expect(source).toContain("ROLE_LABELS");
    expect(source).toContain("member.is_active");
    expect(source).toContain('dvx-badge--success" : "dvx-badge--neutral');
  });

  it("uses a responsive row layout (wraps at narrow widths) rather than a fixed desktop-only table", () => {
    expect(source).not.toContain("<table");
    expect(source).toContain("dvx-team-member-row");
  });
});
