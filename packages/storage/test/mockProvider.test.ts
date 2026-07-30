import { describe, expect, it } from "vitest";
import { buildStorageKey } from "../src/keys.js";
import { MockStorageProvider } from "../src/providers/mockProvider.js";

describe("MockStorageProvider", () => {
  it("stores and retrieves an object by key", async () => {
    const provider = new MockStorageProvider();
    const key = buildStorageKey("aaaaaaaa-0000-0000-0000-000000000001", "audio/inbound", "a.ogg");
    const data = new TextEncoder().encode("hello").buffer;

    await provider.put(key, data, { contentType: "audio/ogg" });
    const result = await provider.get(key);

    expect(result).not.toBeNull();
    expect(new TextDecoder().decode(result!)).toBe("hello");
  });

  it("returns null for a missing key", async () => {
    const provider = new MockStorageProvider();
    expect(await provider.get("companies/x/audio/inbound/missing.ogg")).toBeNull();
  });

  it("deletes an object", async () => {
    const provider = new MockStorageProvider();
    const key = buildStorageKey("aaaaaaaa-0000-0000-0000-000000000001", "audio/inbound", "a.ogg");
    await provider.put(key, new ArrayBuffer(4));
    await provider.delete(key);
    expect(await provider.get(key)).toBeNull();
  });

  it("lists only keys under the given prefix", async () => {
    const provider = new MockStorageProvider();
    const keyA = buildStorageKey("aaaaaaaa-0000-0000-0000-000000000001", "audio/inbound", "a.ogg");
    const keyB = buildStorageKey("bbbbbbbb-0000-0000-0000-000000000002", "audio/inbound", "b.ogg");
    await provider.put(keyA, new ArrayBuffer(4));
    await provider.put(keyB, new ArrayBuffer(4));

    const listed = await provider.list("companies/aaaaaaaa-0000-0000-0000-000000000001/");
    expect(listed).toEqual([keyA]);
  });
});
