import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Company Settings page -- static source assertions rather than importing
 * app/dashboard/settings/page.tsx directly: it transitively imports
 * lib/session.ts, whose getDashboardSession() is wrapped in React's cache()
 * and throws outside Next's server-component runtime (see navItems.test.ts's
 * identical note).
 *
 * Client Dashboard Permission Hardening (migration 00000000000022) made
 * this page fully read-only: settings.manage was revoked from every client
 * role at the database level, so update_company_profile/
 * update_company_timezone/update_company_currency would now be rejected
 * even if this page still rendered forms for them. Company profile,
 * timezone and currency are Dravonix-managed now.
 */

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const source = readFileSync(join(webRoot, "app/dashboard/settings/page.tsx"), "utf8");

describe("Settings page: Company Settings identity", () => {
  it("has the exact required heading", () => {
    expect(source).toContain(">Company Settings<");
  });

  it("never renders Team Settings content -- no member list, role, or team-member badges", () => {
    for (const forbidden of ["Team members", "Team Settings", "maskMemberId", "ROLE_LABELS"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("Settings page: tenant scoping", () => {
  it("resolves the company via the server-derived session, never a client-supplied companyId", () => {
    expect(source).toContain('.eq("id", session.activeCompanyId)');
    const idFilters = [...source.matchAll(/\.eq\("(?:id|company_id)",\s*([\w.]+)\)/g)].map(
      (m) => m[1],
    );
    expect(idFilters.length).toBeGreaterThan(0);
    for (const arg of idFilters) {
      expect(arg).toBe("session.activeCompanyId");
    }
  });

  it("never accepts a companyId parameter on the page's own exported function", () => {
    const signatureMatch = source.match(/export default async function SettingsPage\(([^)]*)\)/);
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch?.[1] ?? "").toBe("");
  });
});

describe("Settings page: permission gating", () => {
  it("gates the company-details query and card behind capabilities.canViewSettings", () => {
    expect(source).toMatch(/capabilities\.canViewSettings\s*\?\s*supabase\s*\.from\("companies"\)/);
    expect(source).toContain("capabilities.canViewSettings ? (");
  });

  it("never queries company_members -- team management lives on its own /dashboard/team route", () => {
    expect(source).not.toContain('.from("company_members")');
    expect(source).not.toContain("canManageTeam");
    expect(source).not.toContain("canViewTeam");
  });

  it("gates the subscription-status card behind capabilities.canViewBilling", () => {
    expect(source).toContain("capabilities.canViewBilling ? (");
  });

  it("gates the WhatsApp connection query and shortcut card behind capabilities.canViewWhatsapp", () => {
    expect(source).toMatch(
      /capabilities\.canViewWhatsapp\s*\?\s*supabase\s*\.from\("whatsapp_accounts"\)/,
    );
    expect(source).toContain("capabilities.canViewWhatsapp ? (");
  });

  it("never references a removed *.manage capability", () => {
    for (const forbidden of [
      "canManageSettings",
      "canManageWhatsapp",
      "canManageBilling",
      "canManageAiSettings",
      "canManageKnowledge",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('never hardcodes an email address or the literal role label "Admin" as an access check', () => {
    expect(source).not.toMatch(/["'][\w.+-]+@[\w.-]+\.\w+["']/);
    expect(source).not.toMatch(/role\s*===?\s*["']Admin["']/);
  });
});

describe("Settings page: read-only company details", () => {
  it("renders company name, industry, country, timezone and currency as read-only rows, never editable inputs", () => {
    expect(source).toContain('label="Company name"');
    expect(source).toContain('label="Industry"');
    expect(source).toContain('label="Country"');
    expect(source).toContain('label="Business timezone"');
    expect(source).toContain('label="Business currency"');
    expect(source).not.toContain("<form");
    expect(source).not.toContain("<input");
    expect(source).not.toContain("<textarea");
  });

  it("no longer imports or renders TimezoneCombobox or CurrencySelect", () => {
    for (const forbidden of ["TimezoneCombobox", "CurrencySelect"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("no longer imports or calls updateCompanyProfileAction", () => {
    expect(source).not.toContain("updateCompanyProfileAction");
  });

  it("explains that company profile changes are made by Dravonix", () => {
    expect(source).toMatch(/managed by Dravonix/);
  });
});

describe("Settings page: real, read-only subscription display", () => {
  it("renders the company's real assigned plan name and subscription state, falling back honestly when unset", () => {
    expect(source).toContain('label="Current plan" value={planInfo?.name ?? "Not assigned"}');
    expect(source).toContain('label="Subscription status"');
    expect(source).not.toMatch(/["']Starter["']|["']Growth["']|["']Professional["']/);
  });

  it("renders no functional Subscribe/Upgrade/Downgrade/Cancel control", () => {
    for (const forbidden of [
      "Subscribe",
      "Upgrade",
      "Downgrade",
      "Cancel subscription",
      "Unsubscribe",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("queries only the subscriptions table (via its embedded plan_versions/plans relation), and never company_entitlements or invoices -- plan/subscription mutation stays Super Admin-only", () => {
    expect(source).toContain('.from("subscriptions")');
    for (const table of ["company_entitlements", "invoices"]) {
      expect(source).not.toContain(`.from("${table}")`);
    }
    expect(source).not.toMatch(/assignPlanAction|changeSubscriptionStateAction/);
  });
});

describe("Settings page: WhatsApp secrets never selected or rendered", () => {
  it("never selects an access-token, app-secret, or verify-token column", () => {
    const rendered = withoutComments(source);
    for (const banned of [
      "encrypted_access_token",
      "META_ACCESS_TOKEN",
      "META_APP_SECRET",
      "META_VERIFY_TOKEN",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]) {
      expect(rendered).not.toContain(banned);
    }
  });
});

describe("Settings page: removed technical cards and fields", () => {
  it("no longer renders the Signed-in user, AI behaviour, or Voice configuration cards", () => {
    expect(source).not.toContain("Signed-in user");
    expect(source).not.toContain("AI behaviour");
    expect(source).not.toContain("Voice configuration");
  });

  it("no longer queries company_settings or voice_settings", () => {
    expect(source).not.toContain('.from("company_settings")');
    expect(source).not.toContain('.from("voice_settings")');
  });

  it("no longer references any AI/voice implementation-detail field", () => {
    for (const field of [
      "bot_name",
      "default_reply_mode",
      "confidence_threshold",
      "ai_active",
      "enabled_languages",
      "provider",
      "retention_days",
      "fallback_behavior",
    ]) {
      expect(source).not.toContain(field);
    }
  });
});
