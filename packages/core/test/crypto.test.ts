import { describe, expect, it } from "vitest";
import { hmacSha256Hex, timingSafeEqualHex } from "../src/crypto.js";

describe("hmacSha256Hex", () => {
  it("matches a known HMAC-SHA256 test vector", async () => {
    // echo -n "hello world" | openssl dgst -sha256 -hmac "secret"
    const digest = await hmacSha256Hex("secret", "hello world");
    expect(digest).toBe("734cc62f32841568f45715aeb9f4d7891324e6d948e4c6c60c0621cdac48623a");
  });

  it("produces different digests for different payloads", async () => {
    const a = await hmacSha256Hex("secret", "payload-a");
    const b = await hmacSha256Hex("secret", "payload-b");
    expect(a).not.toBe(b);
  });

  it("produces different digests for different secrets", async () => {
    const a = await hmacSha256Hex("secret-a", "payload");
    const b = await hmacSha256Hex("secret-b", "payload");
    expect(a).not.toBe(b);
  });
});

describe("timingSafeEqualHex", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualHex("abcd1234", "abcd1234")).toBe(true);
  });

  it("returns false for a single differing character", () => {
    expect(timingSafeEqualHex("abcd1234", "abcd1235")).toBe(false);
  });

  it("returns false for different-length strings instead of throwing", () => {
    expect(timingSafeEqualHex("abcd", "abcd1234")).toBe(false);
  });
});
