import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for lib/actions/admin.ts: every exported Server
 * Action must go through requireSuperAdminClient() (which re-checks
 * getPlatformSession().platformRole === "super_admin" before ever touching
 * Supabase) rather than reading cookies/session state directly, and none of
 * them may call a generic/unrestricted RPC name -- each wraps exactly one
 * named super_admin-gated RPC (migration 17, or migration 32 for the two
 * Phase 7B additions). The RPCs themselves are the real security boundary
 * (re-verified independently in supabase/tests/rls_super_admin.sql and
 * rls_super_admin_subscription_controls.sql, live-Postgres tests, not
 * static ones); this file only guards against a regression where a new
 * action forgets the client-side early check.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

describe("Super Admin Server Actions: every mutation is gated and single-purpose", () => {
  const source = readSource("lib/actions/admin.ts");

  it("defines requireSuperAdminClient() checking platformRole === 'super_admin'", () => {
    expect(source).toContain("async function requireSuperAdminClient()");
    expect(source).toContain('session.platformRole !== "super_admin"');
  });

  const exportedActions = [
    "createCompanyAction",
    "suspendCompanyAction",
    "reactivateCompanyAction",
    "closeCompanyAction",
    "inviteCompanyMemberAction",
    "changeCompanyMemberRoleAction",
    "deactivateCompanyMemberAction",
    "assignPlanAction",
    "changeSubscriptionStateAction",
    "setCompanyEntitlementAction",
    "resetCompanyEntitlementAction",
    "startSupportAccessAction",
    "endSupportAccessAction",
  ];

  it.each(exportedActions)("%s is exported and calls requireSuperAdminClient()", (name) => {
    const fnStart = source.indexOf(`export async function ${name}`);
    expect(fnStart).toBeGreaterThan(-1);
    const nextFnStart = source.indexOf("\nexport async function ", fnStart + 1);
    const fnBody = source.slice(fnStart, nextFnStart === -1 ? undefined : nextFnStart);
    expect(fnBody).toContain("requireSuperAdminClient()");
  });

  it("never calls a generic/unrestricted admin RPC name", () => {
    expect(source).not.toMatch(/admin_update\(/);
    expect(source).not.toMatch(/rpc\(\s*["']admin_update["']/);
  });

  it("each RPC call site names exactly one migration-17 function -- no dynamic/computed RPC name", () => {
    const rpcCalls = source.match(/\.rpc\(\s*"([a-z_]+)"/g) ?? [];
    expect(rpcCalls.length).toBe(exportedActions.length);
  });
});
