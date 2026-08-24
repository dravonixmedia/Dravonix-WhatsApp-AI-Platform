import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the narrow, audited uses of a service_role Supabase client in this
 * app (apps/web/lib/supabase/serviceRole.ts, consumed only by
 * apps/web/lib/actions/reconcileAiOutboundMessage.ts and
 * apps/web/lib/actions/handover.ts's sendHumanReplyAction -- the latter
 * added during the Phase 3A security correction as the server-only
 * replacement for a get_conversation_send_target RPC that had been
 * callable, and exploitable, directly from the browser). These tests exist
 * so that a future accidental import from client-reachable code, or a
 * widening of the service-role surface to ordinary dashboard reads/writes,
 * fails a test immediately instead of only being caught by manual review.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const serviceRolePath = join(webRoot, "lib/supabase/serviceRole.ts");
const serviceRoleSource = readFileSync(serviceRolePath, "utf8");

function listSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".open-next") continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      results.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("service-role client guard", () => {
  it("serviceRole.ts imports the server-only marker package", () => {
    // A textual invariant, not just a behavioral one: proves the guard is
    // still present in source even if a future test-environment change
    // (e.g. a react-server resolve condition added to vitest.config.ts)
    // stopped the dynamic-import test below from throwing.
    expect(serviceRoleSource).toMatch(/^import\s+"server-only";/m);
  });

  it("importing serviceRole.ts outside the server/RSC module graph throws", async () => {
    // This repo's vitest.config.ts runs with environment: "node" and no
    // react-server resolve condition -- the same condition state a Client
    // Component bundle would see. `server-only`'s package.json only maps
    // to a no-op under the "react-server" export condition (which Next.js's
    // own server bundler sets); everywhere else -- including here -- it
    // throws on import. This proves the guard is *live*, not just present
    // as a comment.
    await expect(import("../lib/supabase/serviceRole.js")).rejects.toThrow(
      /cannot be imported from a Client Component/i,
    );
  });

  it("no client-rendered ('use client') file imports the service-role module or reads its key directly", () => {
    const appFiles = listSourceFiles(join(webRoot, "app"));
    const offenders: string[] = [];
    for (const file of appFiles) {
      const source = readFileSync(file, "utf8");
      const isClientComponent = /^["']use client["'];?/m.test(source);
      if (!isClientComponent) continue;
      if (/serviceRole(\.js)?["']/.test(source) || /SUPABASE_SERVICE_ROLE_KEY/.test(source)) {
        offenders.push(relative(webRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only the two audited Server Actions import the service-role client", () => {
    const allSourceFiles = [
      ...listSourceFiles(join(webRoot, "app")),
      ...listSourceFiles(join(webRoot, "lib")),
    ];
    const importers = allSourceFiles
      .filter((file) => file !== serviceRolePath)
      .filter((file) =>
        /from\s+["'].*supabase\/serviceRole(\.js)?["']/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(webRoot, file))
      .sort();

    expect(importers).toEqual([
      "lib/actions/handover.ts",
      "lib/actions/reconcileAiOutboundMessage.ts",
    ]);
  });

  it("the AI-outbound-reconciliation Server Action never accepts a client-supplied company/tenant id", () => {
    const actionSource = readFileSync(
      join(webRoot, "lib/actions/reconcileAiOutboundMessage.ts"),
      "utf8",
    );
    // The action's own signature must stay limited to messageId/
    // conversationId/resolution/reason -- companyId always comes from
    // getDashboardSession()'s live, server-derived activeCompanyId, never
    // from a parameter a client could set to another tenant's id.
    const signatureMatch = actionSource.match(
      /export async function reconcileAiOutboundMessageAction\(([^)]*)\)/,
    );
    expect(signatureMatch).not.toBeNull();
    const signature = signatureMatch?.[1] ?? "";
    expect(signature).not.toMatch(/companyId|company_id|tenantId|tenant_id/i);
    expect(actionSource).toContain("session.activeCompanyId");
  });

  it("Phase 3A: sendHumanReplyAction authorizes via the normal authenticated session BEFORE ever touching the service-role client", () => {
    const actionSource = readFileSync(join(webRoot, "lib/actions/handover.ts"), "utf8");
    const fnMatch = actionSource.match(/export async function sendHumanReplyAction\([\s\S]*?\n}\n/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];

    const authIndex = fnBody.indexOf("repo.getConversationForThread");
    const serviceRoleIndex = fnBody.indexOf("createServerOnlyServiceRoleClient");
    expect(authIndex).toBeGreaterThan(-1);
    expect(serviceRoleIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeLessThan(serviceRoleIndex);
  });

  it("Phase 3A: no removed get_conversation_send_target RPC call remains anywhere in the app", () => {
    // Matches an actual .rpc(...) call site, not the explanatory comments in
    // handover.ts/serviceRoleGuard.test.ts describing why it was removed.
    const allSourceFiles = [
      ...listSourceFiles(join(webRoot, "app")),
      ...listSourceFiles(join(webRoot, "lib")),
    ];
    const offenders = allSourceFiles.filter((file) =>
      /\.rpc\(\s*["']get_conversation_send_target["']/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
