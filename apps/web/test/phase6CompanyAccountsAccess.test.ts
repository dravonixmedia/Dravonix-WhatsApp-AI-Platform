import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 6 (Company Accounts + finance access) -- static source assertions,
 * same convention as memberIdentityDisplayCorrection.test.ts and
 * supportRequestTimezoneWiring.test.ts. The underlying permission matrix
 * (company_accounts = billing.view + usage.view + support_requests.view
 * only) is already fully covered by permissions.test.ts and was NOT
 * changed by this phase -- these tests instead prove the previously-
 * missing application-level route gates now exist (Live Conversations,
 * Human Handover, and the Overview landing page all used to rely on RLS
 * alone), that the new Billing page never queries operational data, and
 * that no billing.manage/billing.pay permission was quietly resurrected.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

/** Strips /** *\/ and // comments so a keyword search only matches real code, never explanatory prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("Live Conversations and Human Handover now deny at the application level, not just RLS", () => {
  const sources = {
    conversationsList: readSource("app/dashboard/conversations/page.tsx"),
    conversationsDetail: readSource("app/dashboard/conversations/[conversationId]/page.tsx"),
    handoverList: readSource("app/dashboard/handover/page.tsx"),
    handoverDetail: readSource("app/dashboard/handover/[conversationId]/page.tsx"),
  };

  for (const [name, source] of Object.entries(sources)) {
    it(`${name} imports getDashboardCapabilities and checks canViewConversations before loading data`, () => {
      expect(source).toContain("getDashboardCapabilities");
      expect(source).toMatch(/if\s*\(!capabilities\.canViewConversations\)\s*return/);
    });
  }
});

describe("The dashboard Overview page never lands a finance-only role on operational data", () => {
  const source = readSource("app/dashboard/page.tsx");

  it("checks capabilities before querying conversations/leads counts", () => {
    const capabilitiesCheckIndex = source.indexOf("getDashboardCapabilities(session.activeRole)");
    const redirectIndex = source.indexOf('redirect("/dashboard/billing")');
    const overviewCountsCallIndex = source.indexOf("loadOverviewCounts(session.activeCompanyId)");
    expect(capabilitiesCheckIndex).toBeGreaterThan(-1);
    expect(redirectIndex).toBeGreaterThan(capabilitiesCheckIndex);
    expect(overviewCountsCallIndex).toBeGreaterThan(redirectIndex);
  });

  it("redirects a role with neither conversations.view nor leads.view to /dashboard/billing", () => {
    expect(source).toMatch(
      /if\s*\(!capabilities\.canViewConversations\s*&&\s*!capabilities\.canViewLeads\)\s*\{\s*redirect\(\s*["']\/dashboard\/billing["']\s*\)/,
    );
  });
});

describe("Sidebar navigation no longer shows Live Conversations/Human Handover/Leads unconditionally", () => {
  const source = readSource("app/dashboard/layout.tsx");

  it("gates the Live Conversations and Human Handover entries on capabilities.canViewConversations", () => {
    const gateIndex = source.indexOf("if (capabilities.canViewConversations) {");
    expect(gateIndex).toBeGreaterThan(-1);
    const gatedBlockEnd = source.indexOf("\n  }", gateIndex);
    const gatedBlock = source.slice(gateIndex, gatedBlockEnd);
    expect(gatedBlock).toContain("/dashboard/conversations");
    expect(gatedBlock).toContain("/dashboard/handover");
  });

  it("gates the Leads entry on capabilities.canViewLeads", () => {
    expect(source).toMatch(
      /if\s*\(capabilities\.canViewLeads\)\s*\{\s*entries\.push\(\{[\s\S]{0,120}\/dashboard\/leads/,
    );
  });

  it("adds a Billing entry gated on capabilities.canViewBilling, pointing at /dashboard/billing", () => {
    expect(source).toMatch(
      /if\s*\(capabilities\.canViewBilling\)\s*\{\s*entries\.push\(\{[\s\S]{0,150}\/dashboard\/billing/,
    );
  });
});

describe("The Billing page is a real finance dashboard, not the old dead redirect", () => {
  const source = readSource("app/dashboard/billing/page.tsx");

  it("no longer redirects to /dashboard/settings", () => {
    expect(source).not.toMatch(/redirect\(\s*["']\/dashboard\/settings["']\s*\)/);
  });

  it("is gated on capabilities.canViewBilling", () => {
    expect(source).toMatch(/if\s*\(!capabilities\.canViewBilling\)\s*return/);
  });

  it("scopes every finance query to the caller's own active company (session.activeCompanyId), never an arbitrary id", () => {
    expect(source).toMatch(/getBillingSubscription\(supabase,\s*session\.activeCompanyId\)/);
    expect(source).toMatch(/listBillingInvoices\(supabase,\s*session\.activeCompanyId\)/);
    expect(source).toMatch(/listBillingPayments\(supabase,\s*session\.activeCompanyId\)/);
    expect(source).toMatch(/entitlementRepo\.getSnapshot\(session\.activeCompanyId\)/);
  });

  it("reuses the existing SupabaseEntitlementRepository rather than re-deriving plan/usage merging logic", () => {
    expect(source).toContain(
      'import { SupabaseEntitlementRepository } from "../../../lib/repositories/supabaseEntitlementRepository.js"',
    );
  });

  it("never queries operational/customer tables -- contacts, conversations, messages, leads, knowledge_sources, ai_settings, or whatsapp_accounts", () => {
    for (const table of [
      '"contacts"',
      '"conversations"',
      '"messages"',
      '"leads"',
      '"knowledge_sources"',
      '"ai_settings"',
      '"whatsapp_accounts"',
    ]) {
      expect(source).not.toContain(`.from(${table})`);
    }
  });

  it("uses the shared timezone-aware formatter for every date it displays, never a bare toLocaleString/toLocaleDateString", () => {
    expect(source).toContain('import { formatDateTime } from "../../../lib/formatDateTime.js"');
    expect(source).not.toMatch(/\.toLocaleString\(\)/);
    expect(source).not.toMatch(/\.toLocaleDateString\(\)/);
  });

  it("reuses the shared member-identity architecture for 'submitted by', never a raw UUID or a second identity system", () => {
    expect(source).toContain("resolveMemberIdentity");
    expect(source).toContain("buildMemberIdentityByUserId");
    expect(source).not.toMatch(/\{payment\.submittedByUserId\}/);
  });

  it("does not offer a Make Payment action -- no real payment capability exists yet (Phase 6B, pending review)", () => {
    expect(stripComments(source).toLowerCase()).not.toMatch(/razorpay|create.?order|checkout/);
  });

  it("links to Support & Requests for billing questions instead of building a second support surface", () => {
    expect(source).toMatch(/href="\/dashboard\/support"/);
  });
});

describe("billing.manage/billing.pay are not resurrected by this phase", () => {
  it("permissions.ts's PermissionKey union still has no billing.manage or billing.pay entry", () => {
    const source = readSource("lib/permissions.ts");
    expect(source).not.toMatch(/"billing\.manage"/);
    expect(source).not.toMatch(/"billing\.pay"/);
  });

  it("no Server Action or page grants billing.manage/billing.pay to any company role", () => {
    for (const relativePath of [
      "app/dashboard/billing/page.tsx",
      "lib/repositories/billingRepository.ts",
    ]) {
      const source = stripComments(readSource(relativePath));
      expect(source).not.toMatch(/billing\.manage|billing\.pay/);
    }
  });
});

describe("Regression: routes that already had their own capability gate are untouched", () => {
  it("Leads, DRAIVA, AI Settings, Knowledge, Team, and WhatsApp Connection still check their existing capability", () => {
    const checks: Array<[string, string]> = [
      ["app/dashboard/leads/page.tsx", "canViewLeads"],
      ["app/dashboard/draiva/page.tsx", "canReplyToConversations"],
      ["app/dashboard/ai-settings/page.tsx", "canViewAiSettings"],
      ["app/dashboard/knowledge/page.tsx", "canViewKnowledge"],
      ["app/dashboard/team/page.tsx", "canViewTeam"],
      ["app/dashboard/settings/whatsapp/page.tsx", "canViewWhatsapp"],
    ];
    for (const [relativePath, capability] of checks) {
      const source = readSource(relativePath);
      expect(source).toContain(capability);
    }
  });
});
