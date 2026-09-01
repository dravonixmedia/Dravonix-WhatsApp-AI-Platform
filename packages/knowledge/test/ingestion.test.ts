import { describe, expect, it } from "vitest";
import {
  chunkText,
  cleanText,
  csvExtractor,
  FileTooLargeError,
  MAX_KNOWLEDGE_DOCUMENT_BYTES,
  plainTextExtractor,
  prepareKnowledgeChunks,
  UnsupportedFileTypeError,
  validateFileSize,
  validateFileType,
} from "../src/ingestion.js";

describe("validateFileType", () => {
  it("accepts plain text, csv, pdf, and docx", () => {
    expect(() => validateFileType("text/plain")).not.toThrow();
    expect(() => validateFileType("text/csv")).not.toThrow();
    expect(() => validateFileType("application/pdf")).not.toThrow();
    expect(() =>
      validateFileType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).not.toThrow();
  });

  it("rejects an unsupported type", () => {
    expect(() => validateFileType("application/x-msdownload")).toThrow(UnsupportedFileTypeError);
  });
});

describe("validateFileSize", () => {
  it("accepts a file under the limit", () => {
    expect(() => validateFileSize(1024, 2048)).not.toThrow();
  });

  it("rejects a file over the limit", () => {
    expect(() => validateFileSize(4096, 2048)).toThrow(FileTooLargeError);
  });
});

describe("cleanText", () => {
  it("normalizes CRLF line endings to LF", () => {
    expect(cleanText("line1\r\nline2")).toBe("line1\nline2");
  });

  it("collapses runs of 3+ blank lines to a single blank line", () => {
    expect(cleanText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("collapses repeated spaces/tabs but preserves single newlines", () => {
    expect(cleanText("a   b\tc\nd")).toBe("a b c\nd");
  });

  it("trims leading and trailing whitespace", () => {
    expect(cleanText("   hello   ")).toBe("hello");
  });
});

describe("plainTextExtractor", () => {
  it("decodes UTF-8 bytes into text", async () => {
    const bytes = new TextEncoder().encode("Hello, world").buffer;
    expect(await plainTextExtractor.extract(bytes)).toBe("Hello, world");
  });
});

describe("csvExtractor", () => {
  it("converts comma-separated rows into readable pipe-delimited lines", async () => {
    const bytes = new TextEncoder().encode("name,price\nWebsite,25000").buffer;
    const text = await csvExtractor.extract(bytes);
    expect(text).toBe("name | price\nWebsite | 25000");
  });
});

describe("chunkText", () => {
  it("keeps a short text as a single chunk", () => {
    expect(chunkText("A short paragraph.")).toEqual(["A short paragraph."]);
  });

  it("splits distinct paragraphs into separate chunks once the size limit is exceeded", () => {
    const paragraph = "x".repeat(500);
    const text = [paragraph, paragraph, paragraph].join("\n\n");
    const chunks = chunkText(text, { maxChunkChars: 800 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(800);
    }
  });

  it("hard-splits a single paragraph longer than the max chunk size", () => {
    const longParagraph = "y".repeat(2500);
    const chunks = chunkText(longParagraph, { maxChunkChars: 800 });
    expect(chunks.length).toBe(4);
    expect(chunks.join("")).toBe(longParagraph);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkText("")).toEqual([]);
  });
});

describe("prepareKnowledgeChunks", () => {
  it("cleans, chunks, and returns non-empty chunks in deterministic order", () => {
    const paragraph = "x".repeat(500);
    const text = [paragraph, paragraph].join("\n\n");
    const chunks = prepareKnowledgeChunks(text, { maxChunkChars: 800 });
    expect(chunks).toEqual(chunkText(cleanText(text), { maxChunkChars: 800 }));
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("returns an empty array for whitespace-only input, never throwing", () => {
    expect(prepareKnowledgeChunks("   \n\n\t  ")).toEqual([]);
  });

  it("returns an empty array for input consisting only of tabs/newlines/CR (mirrors the SQL-side ingest_knowledge_source fix)", () => {
    expect(prepareKnowledgeChunks("\t\t\t")).toEqual([]);
    expect(prepareKnowledgeChunks("\n\n\n")).toEqual([]);
    expect(prepareKnowledgeChunks("\r\r\r")).toEqual([]);
    expect(prepareKnowledgeChunks("\r\n\r\n")).toEqual([]);
    expect(prepareKnowledgeChunks(" \t\n\r ")).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(prepareKnowledgeChunks("")).toEqual([]);
  });

  it("removes any chunk that is empty after trimming", () => {
    // chunkText's own paragraph filter already excludes these in normal
    // operation; this proves prepareKnowledgeChunks's own defense-in-depth
    // filter independently, in case a future chunking change ever produced one.
    const chunks = prepareKnowledgeChunks("Real content.\n\n   \n\nMore real content.");
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });

  it("throws FileTooLargeError using real UTF-8 byte length, not JS string .length", () => {
    // Each Malayalam character below is a multi-byte UTF-8 sequence, so the
    // UTF-8 byte length is several times the JS string .length -- this
    // content must be rejected by its real byte size even though its
    // character count alone would look small. Repeat count is derived from
    // the actual per-unit byte length so this stays correct regardless of
    // exact UTF-8 encoding details.
    const unit = "മലയാളം ";
    const unitBytes = new TextEncoder().encode(unit).length;
    const repeats = Math.ceil((MAX_KNOWLEDGE_DOCUMENT_BYTES + unitBytes * 10) / unitBytes);
    const malayalam = unit.repeat(repeats);
    const byteLength = new TextEncoder().encode(malayalam).length;
    expect(byteLength).toBeGreaterThan(MAX_KNOWLEDGE_DOCUMENT_BYTES);
    expect(malayalam.length).toBeLessThan(byteLength);
    expect(() => prepareKnowledgeChunks(malayalam)).toThrow(FileTooLargeError);
  });

  it("accepts multilingual content within the real byte limit", () => {
    const arabic = "مرحبا بكم في دعم درافونيكس. هذا محتوى تجريبي قصير.";
    expect(() => prepareKnowledgeChunks(arabic)).not.toThrow();
    expect(prepareKnowledgeChunks(arabic).join("")).toContain("دعم");
  });

  it("accepts content exactly at the byte limit and rejects one byte over it", () => {
    const atLimit = "a".repeat(MAX_KNOWLEDGE_DOCUMENT_BYTES);
    expect(() => prepareKnowledgeChunks(atLimit)).not.toThrow();

    const overLimit = "a".repeat(MAX_KNOWLEDGE_DOCUMENT_BYTES + 1);
    expect(() => prepareKnowledgeChunks(overLimit)).toThrow(FileTooLargeError);
  });
});
