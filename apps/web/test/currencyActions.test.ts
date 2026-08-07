import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Business Currency -- static source assertions for updateCompanyCurrencyAction
 * (apps/web/lib/actions/currency.ts), extending the exact pattern established
 * by timezoneActions.test.ts for updateCompanyTimezoneAction rather than
 * inventing a new one: these actions can't be imported and executed directly
 * here without a live Supabase session.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const actionSource = readFileSync(join(webRoot, "lib/actions/currency.ts"), "utf8");
const timezoneActionSource = readFileSync(join(webRoot, "lib/actions/timezone.ts"), "utf8");

describe("updateCompanyCurrencyAction", () => {
  it("resolves the session server-side and rejects when unauthenticated", () => {
    expect(actionSource).toContain("await getDashboardSession()");
    expect(actionSource).toMatch(/if \(!session\) throw new Error\("Not authenticated"\)/);
  });

  it("never accepts a company id parameter -- only a currency string", () => {
    const signatureMatch = actionSource.match(
      /export async function updateCompanyCurrencyAction\(([^)]*)\)/,
    );
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch?.[1] ?? "").not.toMatch(/companyId|company_id/i);
  });

  it("always passes session.activeCompanyId to the RPC, never a client-supplied value", () => {
    expect(actionSource).toMatch(/p_company_id:\s*session\.activeCompanyId/);
  });

  it("delegates all authorization/validation to the update_company_currency RPC rather than checking a role locally", () => {
    expect(actionSource).toContain('rpc("update_company_currency"');
    expect(actionSource).not.toMatch(/role\s*===?\s*["']/);
  });
});

describe("Business timezone and business currency are independent settings", () => {
  it("updateCompanyCurrencyAction never calls the timezone RPC", () => {
    expect(actionSource).not.toContain('rpc("update_company_timezone"');
    expect(actionSource).not.toContain("p_timezone");
  });

  it("updateCompanyTimezoneAction never calls the currency RPC", () => {
    expect(timezoneActionSource).not.toContain('rpc("update_company_currency"');
    expect(timezoneActionSource).not.toContain("p_currency");
    expect(timezoneActionSource).not.toContain("default_currency");
  });

  it("the currency action never reads or derives a value from a timezone field", () => {
    expect(actionSource).not.toContain("company.timezone");
    expect(actionSource).not.toContain(".timezone");
  });
});
