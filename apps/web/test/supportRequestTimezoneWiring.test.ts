import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions (same convention as supportRequestEmailSafety.test.ts)
 * proving the Support & Requests detail pages format timestamps in the
 * *company's* configured timezone rather than falling back to the Cloudflare
 * Worker's host-default UTC clock (a bare `.toLocaleString()`/`.toLocaleDateString()`
 * server-side) or the visitor's browser-local timezone.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

describe("Client support request detail page uses the active company's timezone", () => {
  const source = readSource("app/dashboard/support/[requestId]/page.tsx");

  it("never calls the raw, host-default-timezone toLocaleString/toLocaleDateString", () => {
    expect(source).not.toMatch(/\.toLocaleString\(\)/);
    expect(source).not.toMatch(/\.toLocaleDateString\(\)/);
  });

  it("imports the shared formatDateTime utility and the company timezone lookup", () => {
    expect(source).toContain("formatDateTime");
    expect(source).toContain("getCompanyTimezone");
  });

  it("resolves the timezone from the caller's own active company, not a hardcoded region", () => {
    expect(source).toContain("getCompanyTimezone(supabase, session.activeCompanyId)");
    expect(source).not.toContain("Asia/Kolkata");
  });

  it("passes the resolved company timezone into every formatDateTime call", () => {
    const calls = source.match(/formatDateTime\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain("companyTimezone");
    }
  });
});

describe("Super Admin support request detail page uses the target company's timezone", () => {
  const source = readSource("app/admin/support-requests/[requestId]/page.tsx");

  it("never calls the raw, host-default-timezone toLocaleString/toLocaleDateString", () => {
    expect(source).not.toMatch(/\.toLocaleString\(\)/);
    expect(source).not.toMatch(/\.toLocaleDateString\(\)/);
  });

  it("imports the shared formatDateTime utility and the company timezone lookup", () => {
    expect(source).toContain("formatDateTime");
    expect(source).toContain("getCompanyTimezone");
  });

  it("resolves the timezone from the request's own company_id, never a hardcoded region or Dravonix's own timezone", () => {
    expect(source).toContain("getCompanyTimezone(supabase, request.companyId)");
    expect(source).not.toContain("Asia/Kolkata");
  });

  it("passes the resolved (target-company) timezone into every formatDateTime call", () => {
    const calls = source.match(/formatDateTime\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain("companyTimezone");
    }
  });

  it("resolves the request before resolving the timezone, so it always follows the company being administered", () => {
    const requestFetchIndex = source.indexOf("getAdminSupportRequest(supabase, requestId)");
    const timezoneFetchIndex = source.indexOf("getCompanyTimezone(supabase, request.companyId)");
    expect(requestFetchIndex).toBeGreaterThan(-1);
    expect(timezoneFetchIndex).toBeGreaterThan(requestFetchIndex);
  });
});

describe("The shared formatDateTime utility never trusts an implicit/host-default timezone", () => {
  const source = readSource("lib/formatDateTime.ts");

  it("every Intl.DateTimeFormat call passes an explicit timeZone option", () => {
    const calls = source.match(/new Intl\.DateTimeFormat\([^)]*\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/timeZone:/);
    }
  });

  it("falls back to UTC, never to a specific region like Asia/Kolkata", () => {
    expect(source).toContain('"UTC"');
    expect(source).not.toContain("Asia/Kolkata");
  });
});
