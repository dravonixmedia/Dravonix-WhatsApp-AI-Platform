import type { PutOptions, StorageProvider } from "../provider.js";

/** In-memory storage provider for local development and tests. */
export class MockStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, { data: ArrayBuffer; contentType?: string }>();

  async put(key: string, data: ArrayBuffer | Uint8Array, options?: PutOptions): Promise<void> {
    const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(0);
    this.objects.set(key, { data: buffer as ArrayBuffer, contentType: options?.contentType });
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    return this.objects.get(key)?.data ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return Array.from(this.objects.keys()).filter((key) => key.startsWith(prefix));
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}
