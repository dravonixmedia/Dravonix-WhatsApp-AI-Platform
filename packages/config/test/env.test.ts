import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "../src/env.js";

const base = { APP_ENV: "development" };

describe("loadEnv", () => {
  it("applies safe defaults when only APP_ENV is set", () => {
    const env = loadEnv(base);
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    expect(env.RAZORPAY_MODE).toBe("test");
    expect(env.isProduction).toBe(false);
    expect(env.whatsappConfigured).toBe(false);
    // Already the version every deployed Worker actually uses in staging --
    // dravonix-whatsapp-ai-platform-staging and dravonixapp-staging have
    // never set META_GRAPH_API_VERSION and are already sending real
    // WhatsApp Graph API traffic on this default (see CLOUDFLARE_SETUP.md
    // §5) -- so leaving it unset for dravonix-dashboard-staging is safe,
    // not an unverified assumption.
    expect(env.META_GRAPH_API_VERSION).toBe("v21.0");
  });

  it("rejects an invalid APP_ENV value", () => {
    expect(() => loadEnv({ APP_ENV: "not-a-real-env" })).toThrow(EnvValidationError);
  });

  it("rejects DEV_TENANT_SELECTOR_ENABLED=true in production", () => {
    expect(() => loadEnv({ APP_ENV: "production", DEV_TENANT_SELECTOR_ENABLED: "true" })).toThrow(
      /DEV_TENANT_SELECTOR_ENABLED/,
    );
  });

  it("rejects DEV_TENANT_SELECTOR_ENABLED=true in staging (Human Handover Inbox final plan section 15)", () => {
    expect(() => loadEnv({ APP_ENV: "staging", DEV_TENANT_SELECTOR_ENABLED: "true" })).toThrow(
      /DEV_TENANT_SELECTOR_ENABLED/,
    );
  });

  it("disables the dev tenant selector outside development even where the flag is merely computed, not rejected", () => {
    const env = loadEnv({ APP_ENV: "test", DEV_TENANT_SELECTOR_ENABLED: "true" });
    expect(env.devTenantSelectorEnabled).toBe(false);
  });

  it("rejects RESEARCH_STAGING_ENABLED=true in production (DRAIVA Research staging pilot must never activate in production)", () => {
    expect(() => loadEnv({ APP_ENV: "production", RESEARCH_STAGING_ENABLED: "true" })).toThrow(
      /RESEARCH_STAGING_ENABLED/,
    );
  });

  it("allows RESEARCH_STAGING_ENABLED=true in staging and computes researchStagingEnabled=true", () => {
    const env = loadEnv({ APP_ENV: "staging", RESEARCH_STAGING_ENABLED: "true" });
    expect(env.researchStagingEnabled).toBe(true);
  });

  it("defaults researchStagingEnabled to false when unset", () => {
    const env = loadEnv(base);
    expect(env.researchStagingEnabled).toBe(false);
  });

  it("requires RAZORPAY_KEY_SECRET when running live in production", () => {
    expect(() => loadEnv({ APP_ENV: "production", RAZORPAY_MODE: "live" })).toThrow(
      /RAZORPAY_KEY_SECRET/,
    );
  });

  it("marks providers configured only when their required variables are present", () => {
    const env = loadEnv({
      ...base,
      META_ACCESS_TOKEN: "token",
      META_TEST_PHONE_NUMBER_ID: "123",
      META_APP_SECRET: "secret",
      ANTHROPIC_API_KEY: "sk-ant-test",
      RAZORPAY_KEY_ID: "rzp_test",
      RAZORPAY_KEY_SECRET: "secret",
    });
    expect(env.whatsappConfigured).toBe(true);
    expect(env.anthropicConfigured).toBe(true);
    expect(env.razorpayConfigured).toBe(true);
    expect(env.googleSpeechConfigured).toBe(false);
    expect(env.elevenLabsConfigured).toBe(false);
    expect(env.r2Configured).toBe(false);
  });

  it("marks elevenLabsConfigured true only when ELEVENLABS_API_KEY is present", () => {
    const env = loadEnv({ ...base, ELEVENLABS_API_KEY: "sk-test" });
    expect(env.elevenLabsConfigured).toBe(true);
  });

  it("defaults VOICE_REPLY_MODE to text_only when unset", () => {
    const env = loadEnv(base);
    expect(env.VOICE_REPLY_MODE).toBe("text_only");
  });

  it("accepts an explicit VOICE_REPLY_MODE of text_and_audio", () => {
    const env = loadEnv({ ...base, VOICE_REPLY_MODE: "text_and_audio" });
    expect(env.VOICE_REPLY_MODE).toBe("text_and_audio");
  });

  it("rejects an invalid VOICE_REPLY_MODE value", () => {
    expect(() => loadEnv({ ...base, VOICE_REPLY_MODE: "audio_only" })).toThrow(EnvValidationError);
  });

  it("defaults EMAIL_FROM_NAME and marks emailConfigured false when no email provider is set", () => {
    const env = loadEnv(base);
    expect(env.EMAIL_FROM_NAME).toBe("DRAIVA by Dravonix Media");
    expect(env.emailConfigured).toBe(false);
  });

  it("marks emailConfigured true only when both ZEPTOMAIL_API_TOKEN and EMAIL_FROM_ADDRESS are present", () => {
    expect(loadEnv({ ...base, ZEPTOMAIL_API_TOKEN: "zm_test" }).emailConfigured).toBe(false);
    expect(loadEnv({ ...base, EMAIL_FROM_ADDRESS: "invites@dravonix.test" }).emailConfigured).toBe(
      false,
    );
    expect(
      loadEnv({
        ...base,
        ZEPTOMAIL_API_TOKEN: "zm_test",
        EMAIL_FROM_ADDRESS: "invites@dravonix.test",
      }).emailConfigured,
    ).toBe(true);
  });

  it("resolves emailApiToken from ZEPTOMAIL_API_TOKEN, preferring it over the transitional EMAIL_API_KEY fallback", () => {
    expect(loadEnv({ ...base, ZEPTOMAIL_API_TOKEN: "zm_test" }).emailApiToken).toBe("zm_test");
    expect(
      loadEnv({ ...base, ZEPTOMAIL_API_TOKEN: "zm_test", EMAIL_API_KEY: "old_key" }).emailApiToken,
    ).toBe("zm_test");
  });

  it("falls back to the transitional EMAIL_API_KEY when ZEPTOMAIL_API_TOKEN is unset, for both emailApiToken and emailConfigured", () => {
    expect(loadEnv({ ...base, EMAIL_API_KEY: "old_key" }).emailApiToken).toBe("old_key");
    expect(
      loadEnv({ ...base, EMAIL_API_KEY: "old_key", EMAIL_FROM_ADDRESS: "invites@dravonix.test" })
        .emailConfigured,
    ).toBe(true);
  });

  it("rejects an invalid EMAIL_FROM_ADDRESS value", () => {
    expect(() => loadEnv({ ...base, EMAIL_FROM_ADDRESS: "not-an-email" })).toThrow(
      EnvValidationError,
    );
  });
});
