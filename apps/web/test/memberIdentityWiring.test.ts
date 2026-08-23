import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions that the Super Admin "Users & Roles" card and the
 * client Team page both resolve human-friendly member identity through the
 * one shared helper (lib/memberIdentity.ts) and the one shared RPC
 * (list_company_member_identities), rather than duplicating the
 * name/email/masked-id priority logic, and never render a raw member.user_id
 * (a full auth.users.id UUID) directly into the page.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

const superAdminSource = readSource("app/admin/companies/[id]/page.tsx");
const teamPageSource = readSource("app/dashboard/team/page.tsx");
const dashboardLayoutSource = readSource("app/dashboard/layout.tsx");

describe("human-friendly member identity wiring", () => {
  it("the Super Admin Users & Roles card imports the shared resolveMemberIdentity helper", () => {
    expect(superAdminSource).toMatch(
      /import\s*\{\s*resolveMemberIdentity\s*\}\s*from\s*["'].*memberIdentity\.js["']/,
    );
  });

  it("the Super Admin Users & Roles card calls the shared list_company_member_identities RPC", () => {
    expect(superAdminSource).toMatch(/\.rpc\(\s*["']list_company_member_identities["']/);
  });

  it("the client Team page imports the shared resolveMemberIdentity helper", () => {
    expect(teamPageSource).toMatch(
      /import\s*\{\s*resolveMemberIdentity\s*\}\s*from\s*["'].*memberIdentity\.js["']/,
    );
  });

  it("the client Team page calls the shared list_company_member_identities RPC", () => {
    expect(teamPageSource).toMatch(/\.rpc\(\s*["']list_company_member_identities["']/);
  });

  it("the Super Admin card never interpolates member.user_id directly into rendered markup", () => {
    expect(superAdminSource).not.toMatch(/\{member\.user_id\}/);
  });

  it("the Team page never interpolates member.user_id directly into rendered markup", () => {
    expect(teamPageSource).not.toMatch(/\{member\.user_id\}/);
  });

  it("neither page defines its own competing name/email/masked-id priority logic", () => {
    for (const source of [superAdminSource, teamPageSource]) {
      expect(source).not.toMatch(/function\s+maskMemberId/);
    }
  });

  it("both pages route member.user_id only through resolveMemberIdentity's userId field", () => {
    expect(superAdminSource).toMatch(
      /resolveMemberIdentity\(\{[\s\S]{0,200}userId:\s*member\.user_id/,
    );
    expect(teamPageSource).toMatch(
      /resolveMemberIdentity\(\{[\s\S]{0,200}userId:\s*member\.user_id/,
    );
  });

  it("both pages resolve the editable display_name from list_company_member_identities, not just email", () => {
    expect(superAdminSource).toMatch(/resolveMemberIdentity\(\{[\s\S]{0,200}name:/);
    expect(teamPageSource).toMatch(/resolveMemberIdentity\(\{[\s\S]{0,200}name:/);
  });

  it("the Super Admin card uses the dedicated admin_update_user_display_name RPC (via its Server Action), never the company-scoped one", () => {
    expect(superAdminSource).toMatch(
      /import\s*\{\s*adminUpdateMemberDisplayNameAction\s*\}\s*from\s*["'].*memberIdentity\.js["']/,
    );
    expect(superAdminSource).toMatch(/adminUpdateMemberDisplayNameAction\.bind\(/);
    expect(superAdminSource).not.toMatch(/\bupdateMemberDisplayNameAction\b/);
  });

  it("the Team page uses the company-scoped update_user_display_name RPC (via its Server Action)", () => {
    expect(teamPageSource).toMatch(
      /import\s*\{\s*updateMemberDisplayNameAction\s*\}\s*from\s*["'].*memberIdentity\.js["']/,
    );
    expect(teamPageSource).toMatch(/updateMemberDisplayNameAction\.bind\(/);
  });

  it("both pages render the shared EditDisplayNameControl rather than a bespoke edit form", () => {
    expect(superAdminSource).toMatch(/<EditDisplayNameControl/);
    expect(teamPageSource).toMatch(/<EditDisplayNameControl/);
  });

  it("the dashboard layout's self-edit control uses the company-scoped RPC (self-edit is authorized by that RPC's own is_self bypass)", () => {
    expect(dashboardLayoutSource).toMatch(
      /import\s*\{\s*updateMemberDisplayNameAction\s*\}\s*from\s*["'].*memberIdentity\.js["']/,
    );
    expect(dashboardLayoutSource).toMatch(
      /updateMemberDisplayNameAction\.bind\(\s*null,\s*session\.userId\s*\)/,
    );
    expect(dashboardLayoutSource).toMatch(/<EditDisplayNameControl/);
  });

  it("the dashboard layout never interpolates session.userId directly into rendered markup", () => {
    expect(dashboardLayoutSource).not.toMatch(/\{session\.userId\}/);
  });
});
