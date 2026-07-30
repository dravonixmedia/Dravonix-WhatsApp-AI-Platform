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
  });

  it("rejects an invalid APP_ENV value", () => {
    expect(() => loadEnv({ APP_ENV: "not-a-real-env" })).toThrow(EnvValidationError);
  });

  it("rejects DEV_TENANT_SELECTOR_ENABLED=true in production", () => {
    expect(() => loadEnv({ APP_ENV: "production", DEV_TENANT_SELECTOR_ENABLED: "true" })).toThrow(
      /DEV_TENANT_SELECTOR_ENABLED/,
    );
  });

  it("disables the dev tenant selector outside development even if the flag is true", () => {
    const env = loadEnv({ APP_ENV: "staging", DEV_TENANT_SELECTOR_ENABLED: "true" });
    expect(env.devTenantSelectorEnabled).toBe(false);
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
    expect(env.r2Configured).toBe(false);
  });
});
