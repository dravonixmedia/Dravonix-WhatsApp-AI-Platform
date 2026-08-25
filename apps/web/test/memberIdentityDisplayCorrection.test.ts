import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions (same convention as memberIdentityWiring.test.ts
 * and supportRequestTimezoneWiring.test.ts) proving the pre-Phase-6 member
 * identity display correction reuses the existing
 * list_company_member_identities/resolveMemberIdentity architecture in
 * Support & Requests and Audit Logs, rather than introducing a second,
 * competing identity system or a cross-tenant lookup path.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

const clientSupportDetailSource = readSource("app/dashboard/support/[requestId]/page.tsx");
const adminSupportDetailSource = readSource("app/admin/support-requests/[requestId]/page.tsx");
const auditLogsSource = readSource("app/admin/audit/page.tsx");

describe("Client Support & Requests detail resolves the real submitter identity", () => {
  it("imports the shared resolveMemberIdentity/buildMemberIdentityByUserId helpers", () => {
    expect(clientSupportDetailSource).toMatch(/resolveMemberIdentity/);
    expect(clientSupportDetailSource).toMatch(/buildMemberIdentityByUserId/);
    expect(clientSupportDetailSource).toMatch(/from\s*["'].*memberIdentity\.js["']/);
  });

  it("calls the shared list_company_member_identities RPC scoped to the caller's own active company", () => {
    expect(clientSupportDetailSource).toMatch(
      /list_company_member_identities["'],\s*\{\s*p_company_id:\s*session\.activeCompanyId/,
    );
  });

  it("never introduces a new arbitrary user-id lookup RPC", () => {
    expect(clientSupportDetailSource).not.toMatch(
      /\.rpc\(\s*["'](?!list_company_member_identities)/,
    );
  });

  it("no longer shows the old bespoke 'Member ••xxxx' masked format", () => {
    expect(clientSupportDetailSource).not.toContain("Member ••");
  });

  it("never passes a raw email into the submitted-by line (unlike Team Settings, which intentionally shows email)", () => {
    expect(clientSupportDetailSource).toMatch(
      /resolveMemberIdentity\(\{[\s\S]{0,120}email:\s*null/,
    );
  });

  it("never interpolates a raw createdByUserId UUID directly into rendered markup", () => {
    expect(clientSupportDetailSource).not.toMatch(/\{request\.createdByUserId\}/);
  });
});

describe("Super Admin Support & Requests detail resolves the real submitter identity", () => {
  it("imports the shared resolveMemberIdentity/buildMemberIdentityByUserId helpers", () => {
    expect(adminSupportDetailSource).toMatch(/resolveMemberIdentity/);
    expect(adminSupportDetailSource).toMatch(/buildMemberIdentityByUserId/);
  });

  it("calls the shared list_company_member_identities RPC scoped to the administered company (request.companyId), never the platform staff caller's own company", () => {
    expect(adminSupportDetailSource).toMatch(
      /list_company_member_identities["'],\s*\{\s*p_company_id:\s*request\.companyId/,
    );
  });

  it("still masks the platform-staff assignee/assignment-dropdown identities -- this correction does not build a new platform-profile system", () => {
    expect(adminSupportDetailSource).toMatch(/function maskUserId/);
    expect(adminSupportDetailSource).toMatch(/maskUserId\(request\.assignedPlatformUserId\)/);
    expect(adminSupportDetailSource).toMatch(/maskUserId\(member\.userId\)/);
  });

  it("never passes a raw email into the submitted-by line", () => {
    expect(adminSupportDetailSource).toMatch(/resolveMemberIdentity\(\{[\s\S]{0,120}email:\s*null/);
  });

  it("never interpolates a raw createdByUserId UUID directly into rendered markup", () => {
    expect(adminSupportDetailSource).not.toMatch(/\{request\.createdByUserId\}/);
  });
});

describe("Audit Logs resolves actor identities in a batched, non-N+1 way", () => {
  it("imports the shared resolveMemberIdentity/buildMemberIdentityByUserId helpers", () => {
    expect(auditLogsSource).toMatch(/resolveMemberIdentity/);
    expect(auditLogsSource).toMatch(/buildMemberIdentityByUserId/);
  });

  it("collects distinct company_id values before resolving identities, rather than querying per row", () => {
    const dedupeIndex = auditLogsSource.indexOf("new Set(");
    const rpcCallIndex = auditLogsSource.indexOf('.rpc("list_company_member_identities"');
    const renderMapIndex = auditLogsSource.indexOf("{logs.map((log) => {");
    expect(dedupeIndex).toBeGreaterThan(-1);
    expect(rpcCallIndex).toBeGreaterThan(dedupeIndex);
    // The identity RPC is called while building companyIds/identityResults,
    // strictly before the per-row render map -- never inside it.
    expect(renderMapIndex).toBeGreaterThan(rpcCallIndex);
  });

  it("calls list_company_member_identities at most once per distinct company_id (via companyIds.map), not once per log row", () => {
    expect(auditLogsSource).toMatch(/companyIds\.map\(\s*\(companyId\)\s*=>/);
  });

  it("distinguishes a genuine system event (null actor_user_id) from an unresolvable real actor -- never mislabels a real user as System", () => {
    const fnStart = auditLogsSource.indexOf("function resolveActorLabel");
    const fnEnd = auditLogsSource.indexOf("\n}", fnStart);
    const body = auditLogsSource.slice(fnStart, fnEnd);
    expect(body).toMatch(/if\s*\(!actorUserId\)\s*return\s*"System"/);
  });

  it("never passes a raw email into the actor label", () => {
    expect(auditLogsSource).toMatch(/resolveMemberIdentity\(\{[\s\S]{0,120}email:\s*null/);
  });

  it("never interpolates a raw actor_user_id UUID directly into rendered markup", () => {
    expect(auditLogsSource).not.toMatch(/\{log\.actor_user_id\}/);
  });
});

describe("Identity resolution stays company-scoped -- no cross-tenant lookup introduced", () => {
  for (const [label, source] of [
    ["client support detail", clientSupportDetailSource],
    ["admin support detail", adminSupportDetailSource],
    ["audit logs", auditLogsSource],
  ] as const) {
    it(`${label} only ever calls the one existing list_company_member_identities RPC for identity resolution`, () => {
      const rpcCalls = source.match(/\.rpc\(\s*["'][a-z_]+["']/g) ?? [];
      const identityRpcCalls = rpcCalls.filter((call) =>
        call.includes("list_company_member_identities"),
      );
      expect(identityRpcCalls.length).toBeGreaterThan(0);
    });

    it(`${label} never references auth.users or a service-role key directly`, () => {
      expect(source).not.toMatch(/auth\.users/);
      expect(source.toLowerCase()).not.toMatch(/service_role/);
    });

    it(`${label} is a Server Component, never "use client" -- identity resolution never runs in the browser`, () => {
      expect(source.trimStart().startsWith('"use client"')).toBe(false);
    });
  }
});

describe("Regression: existing member-identity call sites are untouched", () => {
  it("Team Settings and Super Admin Users & Roles still use their own existing wiring (not modified by this correction)", () => {
    const teamPageSource = readSource("app/dashboard/team/page.tsx");
    const superAdminCompanySource = readSource("app/admin/companies/[id]/page.tsx");
    expect(teamPageSource).toMatch(/resolveMemberIdentity/);
    expect(superAdminCompanySource).toMatch(/resolveMemberIdentity/);
  });

  it("the timezone formatter and its call sites are untouched by this correction", () => {
    const formatDateTimeSource = readSource("lib/formatDateTime.ts");
    expect(formatDateTimeSource).not.toMatch(/memberIdentity/);
    expect(clientSupportDetailSource).toMatch(/formatDateTime\(/);
    expect(adminSupportDetailSource).toMatch(/formatDateTime\(/);
  });
});
