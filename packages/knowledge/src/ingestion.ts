export const SUPPORTED_MIME_TYPES = [
  "text/plain",
  "text/csv",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export const MAX_KNOWLEDGE_DOCUMENT_BYTES = 20 * 1024 * 1024; // 20 MB

export class UnsupportedFileTypeError extends Error {
  constructor(mimeType: string) {
    super(`Unsupported knowledge document type: ${mimeType}`);
    this.name = "UnsupportedFileTypeError";
  }
}

/**
 * Stable, machine-readable identifier for FileTooLargeError -- exported
 * separately (not just as the instance's own `code` field) so a caller
 * across a Next.js/OpenNext Server Action boundary can identify it by
 * `error.code` equality rather than `instanceof`, which is not reliable
 * when that boundary's bundler compiles this class's source more than once
 * (see apps/web/lib/domainError.ts for the full explanation).
 */
export const FILE_TOO_LARGE_CODE = "knowledge_file_too_large";

export class FileTooLargeError extends Error {
  readonly code = FILE_TOO_LARGE_CODE;

  constructor(sizeBytes: number, maxBytes: number) {
    super(`File is ${sizeBytes} bytes, exceeding the ${maxBytes} byte limit`);
    this.name = "FileTooLargeError";
  }
}

export function validateFileType(mimeType: string): asserts mimeType is SupportedMimeType {
  if (!(SUPPORTED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new UnsupportedFileTypeError(mimeType);
  }
}

export function validateFileSize(sizeBytes: number, maxBytes = MAX_KNOWLEDGE_DOCUMENT_BYTES): void {
  if (sizeBytes > maxBytes) {
    throw new FileTooLargeError(sizeBytes, maxBytes);
  }
}

/** Collapses excess whitespace and normalizes line endings; does not alter meaningful content. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface TextExtractor {
  mimeType: SupportedMimeType;
  extract(bytes: ArrayBuffer): Promise<string>;
}

/** Plain text and CSV extraction is implemented directly; PDF/DOCX are documented follow-ups (TASKS.md). */
export const plainTextExtractor: TextExtractor = {
  mimeType: "text/plain",
  async extract(bytes: ArrayBuffer): Promise<string> {
    return new TextDecoder("utf-8").decode(bytes);
  },
};

export const csvExtractor: TextExtractor = {
  mimeType: "text/csv",
  async extract(bytes: ArrayBuffer): Promise<string> {
    // Represent each row as a readable line so it chunks/searches sensibly as
    // prose rather than raw comma-separated values.
    const raw = new TextDecoder("utf-8").decode(bytes);
    return raw
      .split("\n")
      .map((line) => line.split(",").join(" | "))
      .join("\n");
  },
};

export interface ChunkOptions {
  maxChunkChars?: number;
}

/**
 * Splits cleaned text into paragraph-respecting chunks no larger than
 * `maxChunkChars`, so a single knowledge_chunks row stays small enough for
 * retrieval to be meaningful (never sending an entire document as one chunk).
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxChunkChars = options.maxChunkChars ?? 800;
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChunkChars && current) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = candidate;
    }

    while (current.length > maxChunkChars) {
      chunks.push(current.slice(0, maxChunkChars).trim());
      current = current.slice(maxChunkChars);
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Composes the validate -> clean -> chunk pipeline into the one call the
 * ingestion write path actually needs (P2 knowledge ingestion). The size
 * check uses the real UTF-8 byte length (`TextEncoder`), not JS string
 * `.length` -- a JS string's `.length` counts UTF-16 code units, which
 * undercounts multi-byte scripts (Malayalam, Arabic, emoji, etc.) relative
 * to the actual bytes a database/storage layer would need to hold, so
 * checking `.length` against a byte limit would let multilingual content
 * silently bypass it.
 *
 * Throws FileTooLargeError (never silently truncates) when oversized;
 * otherwise returns a deterministically-ordered array of non-empty chunk
 * strings, which may legitimately be empty if the input was empty or
 * entirely whitespace after cleaning -- the caller (the ingestion RPC) is
 * responsible for treating an empty result as a failure, not this function.
 * No embeddings, no chunk overlap, no network I/O -- this stays a pure,
 * synchronous function.
 */
export function prepareKnowledgeChunks(raw: string, options: ChunkOptions = {}): string[] {
  const byteLength = new TextEncoder().encode(raw).length;
  validateFileSize(byteLength);

  const cleaned = cleanText(raw);
  return chunkText(cleaned, options).filter((chunk) => chunk.trim().length > 0);
}
