const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export class UnsafeStorageKeyError extends Error {
  constructor(segment: string) {
    super(`Unsafe storage key segment: "${segment}"`);
    this.name = "UnsafeStorageKeyError";
  }
}

export type StorageDomain = "audio/inbound" | "audio/outbound" | "knowledge" | "payment-proofs";

function assertSafeSegment(segment: string): void {
  if (!SAFE_SEGMENT.test(segment) || segment === "." || segment === "..") {
    throw new UnsafeStorageKeyError(segment);
  }
}

/**
 * The ONLY function permitted to construct a tenant-scoped storage key
 * (ADR-0007). Every key is `companies/{companyId}/{domain}/{...parts}`;
 * rejects any segment containing path-traversal characters, slashes, or other
 * unsafe characters rather than sanitizing them, so a malformed identifier
 * fails loudly instead of silently colliding with another tenant's prefix.
 */
export function buildStorageKey(
  companyId: string,
  domain: StorageDomain,
  ...parts: string[]
): string {
  assertSafeSegment(companyId);
  for (const part of parts) {
    assertSafeSegment(part);
  }
  return ["companies", companyId, domain, ...parts].join("/");
}

/** True if `key` falls under the given company's prefix -- used by access-control checks before any read. */
export function keyBelongsToCompany(key: string, companyId: string): boolean {
  return key.startsWith(`companies/${companyId}/`);
}
