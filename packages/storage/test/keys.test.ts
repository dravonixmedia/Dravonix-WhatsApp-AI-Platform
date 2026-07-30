import { describe, expect, it } from "vitest";
import { buildStorageKey, keyBelongsToCompany, UnsafeStorageKeyError } from "../src/keys.js";

const COMPANY_A = "aaaaaaaa-0000-0000-0000-000000000001";
const COMPANY_B = "bbbbbbbb-0000-0000-0000-000000000002";

describe("buildStorageKey", () => {
  it("builds a tenant-scoped key with the expected prefix", () => {
    expect(buildStorageKey(COMPANY_A, "audio/inbound", "msg-1.ogg")).toBe(
      `companies/${COMPANY_A}/audio/inbound/msg-1.ogg`,
    );
  });

  it("produces different prefixes for different companies given the same domain/filename", () => {
    const keyA = buildStorageKey(COMPANY_A, "knowledge", "doc-1.pdf");
    const keyB = buildStorageKey(COMPANY_B, "knowledge", "doc-1.pdf");
    expect(keyA).not.toBe(keyB);
  });

  it("rejects a path-traversal attempt in the company ID", () => {
    expect(() => buildStorageKey("../etc/passwd", "audio/inbound", "x.ogg")).toThrow(
      UnsafeStorageKeyError,
    );
  });

  it("rejects a path-traversal attempt in a filename segment", () => {
    expect(() => buildStorageKey(COMPANY_A, "audio/inbound", "../../secrets.txt")).toThrow(
      UnsafeStorageKeyError,
    );
  });

  it("rejects a segment containing a forward slash", () => {
    expect(() => buildStorageKey(COMPANY_A, "audio/inbound", "sub/dir/file.ogg")).toThrow(
      UnsafeStorageKeyError,
    );
  });

  it("rejects a bare '..' segment", () => {
    expect(() => buildStorageKey(COMPANY_A, "audio/inbound", "..")).toThrow(UnsafeStorageKeyError);
  });

  it("accepts alphanumeric, dash, underscore, and dot characters", () => {
    expect(() => buildStorageKey(COMPANY_A, "knowledge", "My_File-v2.final.pdf")).not.toThrow();
  });
});

describe("keyBelongsToCompany", () => {
  it("returns true for a key under the company's own prefix", () => {
    const key = buildStorageKey(COMPANY_A, "audio/inbound", "msg-1.ogg");
    expect(keyBelongsToCompany(key, COMPANY_A)).toBe(true);
  });

  it("returns false for a key under a different company's prefix", () => {
    const key = buildStorageKey(COMPANY_A, "audio/inbound", "msg-1.ogg");
    expect(keyBelongsToCompany(key, COMPANY_B)).toBe(false);
  });
});
