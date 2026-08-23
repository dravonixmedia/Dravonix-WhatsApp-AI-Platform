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
});
