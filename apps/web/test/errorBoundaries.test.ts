import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the dashboard/admin route error boundaries
 * (P1 stabilization: deadline-recovery audit found Super Admin had no error
 * boundary at all). This repo has no @testing-library/react harness (see
 * notificationBellWiring.test.ts's identical note), so this is covered the
 * same way as the rest of this repo's component-wiring tests: read the
 * source and assert on it, rather than rendering.
 */

/** Strips /** *\/ block and // line comments so doc-comment prose (which legitimately discusses `error.message` as the thing NOT to render) can't produce a false-positive match against the actual code below it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const dashboardErrorSource = readFileSync(join(webRoot, "app/dashboard/error.tsx"), "utf8");
const adminErrorSource = readFileSync(join(webRoot, "app/admin/error.tsx"), "utf8");

describe.each([
  ["dashboard", stripComments(dashboardErrorSource), "/dashboard"],
  ["admin", stripComments(adminErrorSource), "/admin"],
])("%s error boundary", (_name, source, homeHref) => {
  it("is a client-component error boundary accepting error + reset props", () => {
    expect(source).toContain('"use client"');
    expect(source).toMatch(/error:\s*Error\s*&\s*\{\s*digest\?:\s*string\s*\}/);
    expect(source).toContain("reset: () => void");
  });

  it("never renders error.message or any other raw error property besides error.digest", () => {
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("error.stack");
    expect(source).not.toContain("error.cause");
    // The only property access on `error` anywhere in the file must be `.digest`.
    const errorPropertyAccesses = [...source.matchAll(/\berror\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(errorPropertyAccesses)).toEqual(new Set(["digest"]));
  });

  it("offers a retry action and a safe navigation link back to the section root", () => {
    expect(source).toContain("onClick={reset}");
    expect(source).toContain(`href="${homeHref}"`);
  });

  it("shows a generic, user-safe message rather than any backend-specific wording", () => {
    expect(source).toContain("Something went wrong");
    expect(source).not.toMatch(/exception|stack trace|SQL|Postgres|Supabase/i);
  });
});
