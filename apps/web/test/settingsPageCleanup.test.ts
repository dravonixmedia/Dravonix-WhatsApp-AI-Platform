import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Settings simplification pass (client-facing account settings only --
 * subscription/team-management system deferred to
 * claude/subscriptions-team-management). Static source assertions rather
 * than importing app/dashboard/settings/page.tsx directly: it transitively
 * imports lib/session.ts, whose getDashboardSession() is wrapped in React's
 * cache() and throws outside Next's server-component runtime (see
 * navItems.test.ts's identical note).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const source = readFileSync(join(webRoot, "app/dashboard/settings/page.tsx"), "utf8");

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Settings page: tenant scoping", () => {
  it("resolves the company via the server-derived session, never a client-supplied companyId", () => {
    expect(source).toContain('.eq("id", session.activeCompanyId)');
    // No other company-id-shaped literal is ever compared against "id" or
    // "company_id" -- every such filter in this file must read from
    // session.activeCompanyId specifically.
    const idFilters = [...source.matchAll(/\.eq\("(?:id|company_id)",\s*([\w.]+)\)/g)].map(
      (m) => m[1],
    );
    expect(idFilters.length).toBeGreaterThan(0);
    for (const arg of idFilters) {
      expect(arg).toBe("session.activeCompanyId");
    }
  });

  it("scopes the team-members query to the caller's own company_id", () => {
    expect(source).toMatch(
      /from\("company_members"\)[\s\S]{0,150}?\.eq\("company_id",\s*session\.activeCompanyId\)/,
    );
  });

  it("never accepts a companyId parameter on the page's own exported function", () => {
    const signatureMatch = source.match(/export default async function SettingsPage\(([^)]*)\)/);
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch?.[1] ?? "").toBe("");
  });
});

describe("Settings page: permission gating", () => {
  it("gates the company-details query and card behind capabilities.canManageSettings", () => {
    expect(source).toMatch(
      /capabilities\.canManageSettings\s*\?\s*supabase\s*\.from\("companies"\)/,
    );
    expect(source).toContain("capabilities.canManageSettings ? (");
  });

  it("gates the team-members query and card behind capabilities.canManageTeam", () => {
    expect(source).toMatch(
      /capabilities\.canManageTeam\s*\?\s*supabase\s*\.from\("company_members"\)/,
    );
    expect(source).toContain("capabilities.canManageTeam ? (");
  });

  it("never fetches company_members data when the caller lacks canManageTeam -- not just a hidden UI element", () => {
    expect(source).toContain("const members = capabilities.canManageTeam ? (membersResult.data");
  });

  it("gates the subscription-status card behind capabilities.canManageBilling", () => {
    expect(source).toContain("capabilities.canManageBilling ? (");
  });

  it("gates the WhatsApp connection query and shortcut card behind capabilities.canManageWhatsapp", () => {
    expect(source).toMatch(
      /capabilities\.canManageWhatsapp\s*\?\s*supabase\s*\.from\("whatsapp_accounts"\)/,
    );
    expect(source).toContain("capabilities.canManageWhatsapp ? (");
  });

  it('never hardcodes an email address or the literal role label "Admin" as an access check', () => {
    expect(source).not.toMatch(/["'][\w.+-]+@[\w.-]+\.\w+["']/);
    expect(source).not.toMatch(/role\s*===?\s*["']Admin["']/);
  });
});

describe("Settings page: honest subscription placeholder", () => {
  it("never fabricates a plan name, renewal date, or usage figure", () => {
    expect(source).toContain('label="Current plan" value="Not configured"');
    expect(source).toContain('label="Subscription status" value="Not active"');
    expect(source).not.toMatch(/Starter|Growth|Professional/);
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
    // Scoped to the subscription-status card specifically -- the Company
    // Details card legitimately gained a real Business Timezone form
    // (Global Timezone + Daypart Awareness), so a whole-file "no <form>"
    // check would no longer distinguish "no fake subscription UI" from
    // "no forms anywhere on the page" at all.
    const subscriptionCardMatch = source.match(
      /<SectionCard title="Subscription status">[\s\S]*?<\/SectionCard>/,
    );
    expect(subscriptionCardMatch).not.toBeNull();
    expect(subscriptionCardMatch?.[0]).not.toContain("<form");
  });

  it("never queries a subscriptions/plans/entitlements table", () => {
    for (const table of [
      "subscriptions",
      "plans",
      "plan_versions",
      "company_entitlements",
      "invoices",
    ]) {
      expect(source).not.toContain(`.from("${table}")`);
    }
  });
});

describe("Settings page: Business Timezone selector", () => {
  it("renders TimezoneCombobox with the exact required label and supporting text", () => {
    expect(source).toContain('label="Business Timezone"');
    expect(source).toContain(
      'helpText="Used for business hours, operational dates and company-local scheduling context."',
    );
    expect(source).toContain('saveLabel="Save Timezone"');
  });

  it("sources its options from listSupportedTimezones(), never a hardcoded list", () => {
    expect(source).toContain("options={listSupportedTimezones()}");
  });

  it("pre-fills the current company timezone from the server-resolved company row", () => {
    expect(source).toContain('initialValue={company?.timezone ?? ""}');
  });

  it("saves through the existing updateCompanyTimezoneAction Server Action, not a new duplicate one", () => {
    expect(source).toContain("onSave={updateCompanyTimezoneAction}");
  });

  it("no longer uses the native <input list>+<datalist> pattern", () => {
    expect(source).not.toContain("<datalist");
    expect(source).not.toContain('list="timezone-options"');
  });
});

describe("Settings page: Business Currency selector", () => {
  it("renders CurrencySelect with the exact required label and supporting text", () => {
    expect(source).toContain('label="Business Currency"');
    expect(source).toContain(
      'helpText="Used for financial values, billing displays and business-level monetary settings."',
    );
    expect(source).toContain('saveLabel="Save Currency"');
  });

  it("sources its options from listSupportedCurrencies(), never a hardcoded inline list", () => {
    expect(source).toContain("currencies={listSupportedCurrencies()}");
  });

  it("pre-fills the current company currency from the server-resolved company row", () => {
    expect(source).toMatch(/initialValue=\{company\?\.default_currency\s*\?\?\s*"INR"\}/);
  });

  it("saves through a dedicated updateCompanyCurrencyAction Server Action, reusing the existing default_currency column", () => {
    expect(source).toContain("onSave={updateCompanyCurrencyAction}");
  });

  it("is no longer a read-only SettingsRow", () => {
    expect(source).not.toContain('SettingsRow label="Currency"');
  });
});

describe("Settings page: Business Timezone and Business Currency are independent", () => {
  it("the two selectors are wired to two distinct Server Actions, never a shared handler", () => {
    const timezoneCallIndex = source.indexOf("onSave={updateCompanyTimezoneAction}");
    const currencyCallIndex = source.indexOf("onSave={updateCompanyCurrencyAction}");
    expect(timezoneCallIndex).toBeGreaterThan(-1);
    expect(currencyCallIndex).toBeGreaterThan(-1);
    expect(timezoneCallIndex).not.toBe(currencyCallIndex);
  });

  it("the currency selector's initialValue never derives from the timezone field, and vice versa", () => {
    function extractSelfClosingTag(tag: string): string {
      const start = source.indexOf(`<${tag}`);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf("/>", start);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end);
    }

    const timezoneBlock = extractSelfClosingTag("TimezoneCombobox");
    const currencyBlock = extractSelfClosingTag("CurrencySelect");
    expect(timezoneBlock).not.toContain("default_currency");
    expect(currencyBlock).not.toContain("company?.timezone");
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
      "is_enabled",
      "provider",
      "retention_days",
      "fallback_behavior",
    ]) {
      expect(source).not.toContain(field);
    }
  });
});
