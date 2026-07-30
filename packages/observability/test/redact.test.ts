import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("redacts a top-level field named token/secret/password/apiKey", () => {
    const result = redactSecrets({
      token: "sk-ant-abc123",
      secret: "whsec_xyz",
      password: "hunter2",
      apiKey: "AIzaSy123",
    }) as Record<string, unknown>;

    expect(result.token).toBe("[REDACTED]");
    expect(result.secret).toBe("[REDACTED]");
    expect(result.password).toBe("[REDACTED]");
    expect(result.apiKey).toBe("[REDACTED]");
  });

  it("redacts nested sensitive fields", () => {
    const result = redactSecrets({
      provider: { name: "razorpay", config: { access_key: "AKIA123", region: "ap-south-1" } },
    }) as { provider: { config: { access_key: string; region: string } } };

    expect(result.provider.config.access_key).toBe("[REDACTED]");
    expect(result.provider.config.region).toBe("ap-south-1");
  });

  it('blanket-redacts an entire object when its own key looks sensitive (e.g. "credentials")', () => {
    const result = redactSecrets({
      provider: { name: "razorpay", credentials: { access_key: "AKIA123", region: "ap-south-1" } },
    }) as { provider: { credentials: unknown } };

    expect(result.provider.credentials).toBe("[REDACTED]");
  });

  it("redacts sensitive fields inside array elements", () => {
    const result = redactSecrets([{ authorization: "Bearer abc" }, { name: "ok" }]) as Array<
      Record<string, unknown>
    >;
    expect(result[0]?.authorization).toBe("[REDACTED]");
    expect(result[1]?.name).toBe("ok");
  });

  it("masks an inline Bearer token inside a string value", () => {
    const result = redactSecrets("Authorization header was: Bearer abc123.def456");
    expect(result).toBe("Authorization header was: Bearer [REDACTED]");
  });

  it("leaves non-sensitive fields untouched", () => {
    const result = redactSecrets({ companyId: "c-1", conversationId: "conv-1" });
    expect(result).toEqual({ companyId: "c-1", conversationId: "conv-1" });
  });

  it("leaves primitives untouched", () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets(null)).toBe(null);
  });
});
