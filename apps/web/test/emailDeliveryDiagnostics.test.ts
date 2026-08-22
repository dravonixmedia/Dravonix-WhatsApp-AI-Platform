import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the Super Admin "Email delivery
 * configuration" diagnostic added to app/admin/page.tsx (same convention as
 * adminActionsSafety.test.ts/invitationEmailSafety.test.ts -- this is a
 * Server Component that depends on a real Supabase client and process.env,
 * so it's checked by inspecting what the source actually does rather than a
 * live integration test). Added after a real staging invitation attempt
 * failed with error_code "not_configured" and there was no safe way to tell
 * *which* of the four required env values was actually missing without
 * reading a secret.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

describe("The email delivery diagnostic never exposes a secret value", () => {
  const source = readSource("app/admin/page.tsx");

  it("getEmailDeliveryDiagnostics only ever returns booleans, never a raw env value", () => {
    const fnStart = source.indexOf("function getEmailDeliveryDiagnostics");
    const fnEnd = source.indexOf("\n}", fnStart);
    const body = source.slice(fnStart, fnEnd);
    expect(body).toContain("zeptoMailTokenPresent: Boolean(env.emailApiToken)");
    expect(body).toContain("emailFromAddressPresent: Boolean(env.EMAIL_FROM_ADDRESS)");
    expect(body).toContain("emailFromNamePresent: Boolean(env.EMAIL_FROM_NAME)");
    expect(body).toContain("appUrlPresent: Boolean(env.APP_URL)");
    // Never returns the field itself unwrapped (e.g. `env.EMAIL_FROM_ADDRESS,`).
    expect(body).not.toMatch(
      /:\s*env\.(EMAIL_FROM_ADDRESS|EMAIL_FROM_NAME|APP_URL|emailApiToken|ZEPTOMAIL_API_TOKEN|EMAIL_API_KEY)\s*[,}]/,
    );
  });

  it("never logs, prints, or otherwise surfaces any env value", () => {
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
  });

  it("the rendered card only shows Present/Missing badges, never a value", () => {
    expect(source).toContain('present ? "Present" : "Missing"');
    expect(source).not.toMatch(
      /\{emailDiagnostics\.(?!zeptoMailTokenPresent|emailFromAddressPresent|emailFromNamePresent|appUrlPresent|emailConfigured)/,
    );
  });

  it("relies on the existing admin layout's super_admin gate rather than adding a second, separate auth check", () => {
    // Matches the established pattern documented on loadPlatformCounts in
    // this same file: app/admin/layout.tsx already gates the whole /admin/*
    // tree, so no page under it re-implements its own authorization.
    expect(source).not.toMatch(/getPlatformSession|requireSuperAdmin/);
  });
});
