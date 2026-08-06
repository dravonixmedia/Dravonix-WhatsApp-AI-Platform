import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Dashboard-correction pass: Knowledge Base and Billing have no client-ready
 * management module (packages/knowledge is retrieval/ingestion-utility only;
 * Billing had no real subscription data behind it, just a fabricated
 * placeholder plan) and must never appear in the sidebar for any role.
 * Settings and WhatsApp Connection must appear only for roles holding the
 * matching real permission -- never gated by a hardcoded email or role
 * string.
 *
 * Static source assertions rather than importing app/dashboard/layout.tsx
 * directly: that file transitively imports lib/session.ts, which wraps
 * getDashboardSession() in React's cache() -- a real RSC-only API that
 * throws when the module graph loads outside Next's server-component
 * runtime (this repo's vitest config runs plain node, matching every other
 * "use server"/session-adjacent file this codebase already tests this way;
 * see sendHumanReplyGuard.test.ts / serviceRoleGuard.test.ts).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const layoutSource = readFileSync(join(webRoot, "app/dashboard/layout.tsx"), "utf8");

describe("dashboard sidebar navigation", () => {
  it("never constructs a Knowledge Base nav entry -- no client-ready management module exists", () => {
    // Scoped to the actual NavLinkItem construction pattern, not a blanket
    // text ban -- this file's own explanatory comments legitimately mention
    // "Knowledge Base" to document *why* it was removed, and comments never
    // ship to a rendered page or client bundle.
    expect(layoutSource).not.toMatch(/label:\s*"Knowledge Base"/);
    expect(layoutSource).not.toMatch(/href:\s*"\/dashboard\/knowledge"/);
  });

  it("never constructs a Billing nav entry -- no client-ready subscription system exists yet", () => {
    expect(layoutSource).not.toMatch(/label:\s*"Billing"/);
    expect(layoutSource).not.toMatch(/href:\s*"\/dashboard\/billing"/);
  });

  it("gates the Settings nav entry behind at least one of its section permissions, never a hardcoded email or role", () => {
    const settingsBlockMatch = layoutSource.match(
      /if \(\s*capabilities\.canManageSettings[\s\S]{0,200}?\) \{[\s\S]{0,200}?\}/,
    );
    expect(settingsBlockMatch).not.toBeNull();
    expect(settingsBlockMatch?.[0]).toContain("capabilities.canManageTeam");
    expect(settingsBlockMatch?.[0]).toContain("capabilities.canManageBilling");
    expect(settingsBlockMatch?.[0]).toContain('href: "/dashboard/settings"');
  });

  it("the Billing route itself redirects rather than rendering a fabricated placeholder plan", () => {
    const billingRouteSource = readFileSync(
      join(webRoot, "app/dashboard/billing/page.tsx"),
      "utf8",
    );
    // Comments legitimately document *why* the old fabricated plan text was
    // removed; strip them before checking it's gone from anything that
    // could actually render.
    const withoutComments = billingRouteSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(billingRouteSource).toContain('redirect("/dashboard/settings")');
    expect(withoutComments).not.toContain("Starter (trial)");
  });

  it("gates the WhatsApp Connection nav entry behind capabilities.canManageWhatsapp, never a hardcoded email or role", () => {
    const whatsappBlockMatch = layoutSource.match(
      /if \(capabilities\.canManageWhatsapp\) \{[\s\S]{0,250}?\}/,
    );
    expect(whatsappBlockMatch).not.toBeNull();
    expect(whatsappBlockMatch?.[0]).toContain('href: "/dashboard/settings/whatsapp"');
  });

  it("never hardcodes an email address anywhere in the nav-building logic", () => {
    // Loose heuristic: any bare "user@domain"-shaped literal string would be
    // a hardcoded-email red flag; this file should contain none.
    expect(layoutSource).not.toMatch(/["'][\w.+-]+@[\w.-]+\.\w+["']/);
  });

  it("the Knowledge Base route itself redirects rather than rendering a developer placeholder", () => {
    const knowledgeRouteSource = readFileSync(
      join(webRoot, "app/dashboard/knowledge/page.tsx"),
      "utf8",
    );
    expect(knowledgeRouteSource).toContain('redirect("/dashboard")');
  });
});
