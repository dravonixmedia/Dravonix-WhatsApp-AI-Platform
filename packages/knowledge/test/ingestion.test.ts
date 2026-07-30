import { describe, expect, it } from "vitest";
import {
  chunkText,
  cleanText,
  csvExtractor,
  FileTooLargeError,
  plainTextExtractor,
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
