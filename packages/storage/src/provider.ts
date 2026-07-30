export interface PutOptions {
  contentType?: string;
}

/**
 * Storage-backend-agnostic interface (ADR-0007). Callers must obtain `key`
 * exclusively from `buildStorageKey` -- never construct one by hand.
 */
export interface StorageProvider {
  put(key: string, data: ArrayBuffer | Uint8Array, options?: PutOptions): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
