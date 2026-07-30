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

export class FileTooLargeError extends Error {
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
