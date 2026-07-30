import type { PutOptions, StorageProvider } from "../provider.js";

/**
 * Minimal shape of Cloudflare's R2Bucket binding this adapter depends on
 * (subset of `@cloudflare/workers-types`'s `R2Bucket`). Declared locally rather
 * than taking a hard dependency on workers-types, since apps/api's Wrangler
 * config supplies the real binding at runtime.
 */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ objects: Array<{ key: string }> }>;
}

/** Real Cloudflare R2 adapter (ADR-0007), used for temporary inbound/outbound audio and processed media. */
export class R2StorageProvider implements StorageProvider {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, data: ArrayBuffer | Uint8Array, options?: PutOptions): Promise<void> {
    await this.bucket.put(key, data, {
      httpMetadata: options?.contentType ? { contentType: options.contentType } : undefined,
    });
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return object.arrayBuffer();
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const result = await this.bucket.list({ prefix });
    return result.objects.map((o) => o.key);
  }
}
