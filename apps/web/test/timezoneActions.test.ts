import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Global Timezone + Daypart Awareness -- static source assertions for the
 * two timezone-update Server Actions (apps/web/lib/actions/timezone.ts).
 * Matches every other Server Action test in this repo (see
 * sendHumanReplyGuard.test.ts's identical note): these actions can't be
 * imported and executed directly here without a live Supabase session.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const actionSource = readFileSync(join(webRoot, "lib/actions/timezone.ts"), "utf8");

describe("updateCompanyTimezoneAction", () => {
  it("resolves the session server-side and rejects when unauthenticated", () => {
    expect(actionSource).toContain("await getDashboardSession()");
    expect(actionSource).toMatch(/if \(!session\) throw new Error\("Not authenticated"\)/);
  });

  it("never accepts a company id parameter -- only a timezone string", () => {
    const signatureMatch = actionSource.match(
      /export async function updateCompanyTimezoneAction\(([^)]*)\)/,
    );
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch?.[1] ?? "").not.toMatch(/companyId|company_id/i);
  });

  it("always passes session.activeCompanyId to the RPC, never a client-supplied value", () => {
    expect(actionSource).toMatch(/p_company_id:\s*session\.activeCompanyId/);
  });

  it("delegates all authorization/validation to the update_company_timezone RPC rather than checking a role locally", () => {
    expect(actionSource).toContain('rpc("update_company_timezone"');
    expect(actionSource).not.toMatch(/role\s*===?\s*["']/);
  });
});

describe("updateContactTimezoneAction", () => {
  it("resolves the session server-side and rejects when unauthenticated", () => {
    const fnBody = actionSource.slice(actionSource.indexOf("updateContactTimezoneAction"));
    expect(fnBody).toContain("await getDashboardSession()");
    expect(fnBody).toMatch(/if \(!session\) throw new Error\("Not authenticated"\)/);
  });

  it("never accepts a companyId parameter -- the RPC derives company from the contact row itself", () => {
    const signatureMatch = actionSource.match(
      /export async function updateContactTimezoneAction\(([^)]*)\)/,
    );
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch?.[1] ?? "").not.toMatch(/companyId|company_id/i);
  });

  it("passes only contactId and timezone to the RPC, never a company id", () => {
    expect(actionSource).toContain('rpc("update_contact_timezone"');
    expect(actionSource).toMatch(/p_contact_id:\s*contactId/);
    expect(actionSource).toMatch(/p_timezone:\s*timezone/);
  });

  it("allows null to explicitly restore 'unknown' -- never silently rejects clearing a timezone", () => {
    const signatureMatch = actionSource.match(
      /export async function updateContactTimezoneAction\(([^)]*)\)/,
    );
    expect(signatureMatch?.[1] ?? "").toContain("string | null");
  });
});

describe("both timezone actions", () => {
  it("never hardcode Asia/Kolkata or any other region as a fallback timezone", () => {
    expect(actionSource).not.toMatch(/Asia\/Kolkata/);
  });

  it("never infer a timezone from a phone number or country code", () => {
    expect(actionSource).not.toMatch(/phone|country_?code|dial_?code/i);
  });
});
