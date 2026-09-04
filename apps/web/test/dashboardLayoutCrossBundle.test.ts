import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Cross-bundle regression coverage for app/dashboard/layout.tsx, part of
 * the same Batch 2 hardening pass that replaced `error instanceof
 * WhatsAppServiceWindowClosedError` with a stable `.code` check (see
 * apps/web/lib/domainError.ts). NoCompanyAccessError is confirmed
 * duplicated -- as five independent class definitions -- in this app's own
 * built OpenNext output, exactly like the WhatsApp errors were, so this
 * layout's `error instanceof NoCompanyAccessError` check carried the same
 * risk: on a mismatch, the code fell through to `throw error`, producing a
 * hard error page for every signed-in user with zero company memberships
 * instead of the intended friendly page.
 *
 * Source-text verification only, matching this codebase's own established
 * convention for .tsx files (see chatAgentPanelWiring.test.ts: "no
 * @testing-library/react"; vitest.config.ts's `include` only matches
 * `*.test.ts`, and no JSX transform is configured for Vitest) -- actually
 * invoking DashboardLayout's JSX-returning function would require adding a
 * JSX runtime to the shared Vitest config, a change with a far larger
 * blast radius than this targeted hardening pass. The control test below
 * (plain classes, no React involved) still directly proves the exact
 * mechanism this fix relies on.
 */

class RealShapedError extends Error {
  constructor(public readonly code: string) {
    super("This account has no active company membership.");
  }
}
class DuplicateBundleShapedError extends Error {
  constructor(public readonly code: string) {
    super("This account has no active company membership. (duplicate-bundle stand-in)");
  }
}

describe("layout.tsx cross-bundle NoCompanyAccessError identification", () => {
  it("control: two independently-defined classes sharing a code are never `instanceof` each other -- pins the exact mechanism that broke the pre-hardening instanceof check", () => {
    const a = new RealShapedError("no_company_access");
    const b = new DuplicateBundleShapedError("no_company_access");
    expect(a).not.toBeInstanceOf(DuplicateBundleShapedError);
    expect(b).not.toBeInstanceOf(RealShapedError);
    // ...but both are ordinary Errors carrying the same stable code, which
    // is exactly what isDomainError(error, code) checks instead.
    expect(a).toBeInstanceOf(Error);
    expect(b).toBeInstanceOf(Error);
    expect(a.code).toBe(b.code);
  });

  it("no longer identifies NoCompanyAccessError via instanceof, and no longer imports the class at all", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const layoutSource = readFileSync(join(here, "..", "app/dashboard/layout.tsx"), "utf8");
    expect(layoutSource).not.toMatch(/instanceof NoCompanyAccessError/);
    expect(layoutSource).not.toMatch(/\bNoCompanyAccessError\b/);
  });

  it("identifies the closed-window-equivalent outcome via isDomainError against the stable NO_COMPANY_ACCESS_CODE, still rendering the same friendly page", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const layoutSource = readFileSync(join(here, "..", "app/dashboard/layout.tsx"), "utf8");
    expect(layoutSource).toMatch(
      /import \{ isDomainError \} from "\.\.\/\.\.\/lib\/domainError\.js"/,
    );
    expect(layoutSource).toMatch(
      /import \{ getDashboardSession, NO_COMPANY_ACCESS_CODE \} from "\.\.\/\.\.\/lib\/session\.js"/,
    );
    const catchBlock = layoutSource.slice(
      layoutSource.indexOf("} catch (error) {"),
      layoutSource.indexOf("throw error;") + "throw error;".length,
    );
    expect(catchBlock).toMatch(/if \(isDomainError\(error, NO_COMPANY_ACCESS_CODE\)\) \{/);
    expect(catchBlock).toContain("<NoCompanyAccessPage />");
    expect(catchBlock).toContain("throw error;");
  });

  it("session.ts's NO_COMPANY_ACCESS_CODE is defined alongside NoCompanyAccessError itself (single source of truth)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sessionSource = readFileSync(join(here, "..", "lib/session.ts"), "utf8");
    expect(sessionSource).toMatch(/export const NO_COMPANY_ACCESS_CODE = "no_company_access";/);
    expect(sessionSource).toMatch(/readonly code = NO_COMPANY_ACCESS_CODE;/);
    expect(sessionSource).toContain("export class NoCompanyAccessError extends Error");
  });
});
