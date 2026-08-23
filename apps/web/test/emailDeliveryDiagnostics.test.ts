import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getEmailDeliveryDiagnostics } from "../lib/emailDeliveryDiagnostics.js";

/**
 * Real behavioral tests for getEmailDeliveryDiagnostics (apps/web/lib/
 * emailDeliveryDiagnostics.ts) -- this is a pure function over an env
 * source object, so unlike most Server Component/Action files in this app it
 * needs no Supabase mocking and can be tested directly rather than only via
 * static source assertions.
 *
 * Regression coverage for a real bug found via a live staging diagnostic:
 * APP_URL and EMAIL_FROM_NAME both have a z.string().default(...) in
 * packages/config/src/env.ts, so loadEnv(source).APP_URL/.EMAIL_FROM_NAME
 * are *always* truthy after parsing -- checking the resolved value (as the
 * first version of this diagnostic did) reports "Present" even when
 * Cloudflare never bound a value at all, which is exactly backwards for a
 * presence diagnostic. This file locks in the fix: those two fields must be
 * checked against the raw, pre-default source.
 */
describe("getEmailDeliveryDiagnostics", () => {
  const BASE = {
    APP_ENV: "staging",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
  };

  it("reports everything missing when nothing is configured", () => {
    expect(getEmailDeliveryDiagnostics(BASE)).toEqual({
      zeptoMailTokenPresent: false,
      emailFromAddressPresent: false,
      emailFromNamePresent: false,
      appUrlPresent: false,
      emailConfigured: false,
    });
  });

  it("reports APP_URL/EMAIL_FROM_NAME as Missing even though loadEnv() defaults them -- the exact regression this was built to catch", () => {
    const result = getEmailDeliveryDiagnostics({
      ...BASE,
      ZEPTOMAIL_API_TOKEN: "zm_test",
      EMAIL_FROM_ADDRESS: "admin@dravonixmedia.com",
      // APP_URL and EMAIL_FROM_NAME deliberately left unset.
    });
    expect(result.appUrlPresent).toBe(false);
    expect(result.emailFromNamePresent).toBe(false);
    // The rest of the diagnostic is unaffected by the default-masking bug.
    expect(result.zeptoMailTokenPresent).toBe(true);
    expect(result.emailFromAddressPresent).toBe(true);
    expect(result.emailConfigured).toBe(true);
  });

  it("reports APP_URL/EMAIL_FROM_NAME as Present when the raw source actually provides them", () => {
    const result = getEmailDeliveryDiagnostics({
      ...BASE,
      APP_URL: "https://dravonix-dashboard-staging.example.workers.dev",
      EMAIL_FROM_NAME: "DRAIVA by Dravonix Media",
    });
    expect(result.appUrlPresent).toBe(true);
    expect(result.emailFromNamePresent).toBe(true);
  });

  it("reproduces the real staging failure: token present, EMAIL_FROM_ADDRESS missing -> emailConfigured false", () => {
    const result = getEmailDeliveryDiagnostics({
      ...BASE,
      ZEPTOMAIL_API_TOKEN: "zm_test",
      EMAIL_FROM_NAME: "DRAIVA by Dravonix Media",
      APP_URL: "https://dravonix-dashboard-staging.example.workers.dev",
      // EMAIL_FROM_ADDRESS deliberately left unset.
    });
    expect(result).toEqual({
      zeptoMailTokenPresent: true,
      emailFromAddressPresent: false,
      emailFromNamePresent: true,
      appUrlPresent: true,
      emailConfigured: false,
    });
  });

  it("resolves zeptoMailTokenPresent from the transitional EMAIL_API_KEY fallback when ZEPTOMAIL_API_TOKEN is absent", () => {
    const result = getEmailDeliveryDiagnostics({
      ...BASE,
      EMAIL_API_KEY: "legacy_key",
      EMAIL_FROM_ADDRESS: "admin@dravonixmedia.com",
    });
    expect(result.zeptoMailTokenPresent).toBe(true);
    expect(result.emailConfigured).toBe(true);
  });

  it("marks emailConfigured true only when a token is present, and EMAIL_FROM_ADDRESS is present", () => {
    expect(
      getEmailDeliveryDiagnostics({ ...BASE, ZEPTOMAIL_API_TOKEN: "zm_test" }).emailConfigured,
    ).toBe(false);
    expect(
      getEmailDeliveryDiagnostics({ ...BASE, EMAIL_FROM_ADDRESS: "admin@dravonixmedia.com" })
        .emailConfigured,
    ).toBe(false);
    expect(
      getEmailDeliveryDiagnostics({
        ...BASE,
        ZEPTOMAIL_API_TOKEN: "zm_test",
        EMAIL_FROM_ADDRESS: "admin@dravonixmedia.com",
      }).emailConfigured,
    ).toBe(true);
  });

  it("never returns anything other than booleans -- no value ever leaks through this diagnostic", () => {
    const result = getEmailDeliveryDiagnostics({
      ...BASE,
      ZEPTOMAIL_API_TOKEN: "zm_super_secret_value_should_never_appear",
      EMAIL_FROM_ADDRESS: "admin@dravonixmedia.com",
      EMAIL_FROM_NAME: "DRAIVA by Dravonix Media",
      APP_URL: "https://dravonix-dashboard-staging.example.workers.dev",
    });
    for (const value of Object.values(result)) {
      expect(typeof value).toBe("boolean");
    }
  });
});

describe("The email delivery diagnostic UI never exposes a secret value", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = join(here, "..");
  const source = readFileSync(join(webRoot, "app/admin/page.tsx"), "utf8");

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
