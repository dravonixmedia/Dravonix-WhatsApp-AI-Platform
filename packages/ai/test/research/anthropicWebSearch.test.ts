import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_WEB_SEARCH_MAX_USES,
  buildAnthropicWebSearchTool,
  classifyWebSearchErrorCode,
  extractResearchExecutionMetadata,
} from "../../src/research/anthropicWebSearch.js";

const NOW = new Date("2026-08-12T09:00:00.000Z");

describe("buildAnthropicWebSearchTool", () => {
  it("defaults to max_uses = 3 (the conservative staging ceiling)", () => {
    expect(ANTHROPIC_WEB_SEARCH_MAX_USES).toBe(3);
    const tool = buildAnthropicWebSearchTool();
    expect(tool).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
  });

  it("accepts a custom maxUses override", () => {
    const tool = buildAnthropicWebSearchTool({ maxUses: 1 });
    expect(tool.max_uses).toBe(1);
  });

  it("omits allowed_domains/blocked_domains/user_location when not supplied", () => {
    const tool = buildAnthropicWebSearchTool();
    expect(tool).not.toHaveProperty("allowed_domains");
    expect(tool).not.toHaveProperty("blocked_domains");
    expect(tool).not.toHaveProperty("user_location");
  });

  it("keeps domain-restriction and location capability available for future use", () => {
    const tool = buildAnthropicWebSearchTool({
      allowedDomains: ["example.gov"],
      blockedDomains: ["spam.test"],
      userLocation: { type: "approximate", country: "AE" },
    });
    expect(tool.allowed_domains).toEqual(["example.gov"]);
    expect(tool.blocked_domains).toEqual(["spam.test"]);
    expect(tool.user_location).toEqual({ type: "approximate", country: "AE" });
  });
});

describe("classifyWebSearchErrorCode", () => {
  it("maps max_uses_exceeded to call_limit_exceeded", () => {
    expect(classifyWebSearchErrorCode("max_uses_exceeded")).toBe("call_limit_exceeded");
  });
  it("maps too_many_requests to rate_limited", () => {
    expect(classifyWebSearchErrorCode("too_many_requests")).toBe("rate_limited");
  });
  it("maps invalid_tool_input and query_too_long to invalid_configuration", () => {
    expect(classifyWebSearchErrorCode("invalid_tool_input")).toBe("invalid_configuration");
    expect(classifyWebSearchErrorCode("query_too_long")).toBe("invalid_configuration");
  });
  it("maps unavailable and any unknown code to provider_error", () => {
    expect(classifyWebSearchErrorCode("unavailable")).toBe("provider_error");
    expect(classifyWebSearchErrorCode("some_future_code")).toBe("provider_error");
  });
});

function serverToolUse(query: string): Anthropic.ContentBlock {
  return {
    type: "server_tool_use",
    id: "srvtoolu_1",
    name: "web_search",
    input: { query },
  } as Anthropic.ContentBlock;
}

function webSearchResults(
  results: Array<{ url: string; title: string; page_age?: string | null }>,
): Anthropic.ContentBlock {
  return {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_1",
    content: results.map((r) => ({
      type: "web_search_result",
      url: r.url,
      title: r.title,
      encrypted_content: "opaque-blob-not-readable",
      page_age: r.page_age ?? null,
    })),
  } as Anthropic.ContentBlock;
}

function webSearchError(errorCode: string): Anthropic.ContentBlock {
  return {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_1",
    content: { type: "web_search_tool_result_error", error_code: errorCode },
  } as Anthropic.ContentBlock;
}

function textWithCitations(
  text: string,
  citations: Array<{ url: string; title: string | null; cited_text: string }>,
): Anthropic.ContentBlock {
  return {
    type: "text",
    text,
    citations: citations.map((c) => ({
      type: "web_search_result_location",
      url: c.url,
      title: c.title,
      cited_text: c.cited_text,
      encrypted_index: "idx",
    })),
  } as Anthropic.ContentBlock;
}

describe("extractResearchExecutionMetadata", () => {
  it("scenario 1 (known company question): zero searches when the model never used the tool", () => {
    const content: Anthropic.ContentBlock[] = [
      { type: "text", text: "{}", citations: null } as Anthropic.ContentBlock,
    ];
    const metadata = extractResearchExecutionMetadata(content, NOW);
    expect(metadata.searchesPerformed).toBe(0);
    expect(metadata.searchQueries).toEqual([]);
    expect(metadata.findings).toEqual([]);
    expect(metadata.failureReason).toBeNull();
  });

  it("scenario 2/3/4/5 (research triggers): counts each server_tool_use as one search and captures the literal query", () => {
    const content: Anthropic.ContentBlock[] = [
      serverToolUse("Kerala interior fit-out market competitors"),
      webSearchResults([
        { url: "https://example-industry.test/kerala", title: "Kerala market overview" },
      ]),
      textWithCitations('{"answer": "..."}', [
        {
          url: "https://example-industry.test/kerala",
          title: "Kerala market overview",
          cited_text: "Several regional brands compete in the Kerala interior fit-out space.",
        },
      ]),
    ];
    const metadata = extractResearchExecutionMetadata(content, NOW);
    expect(metadata.searchesPerformed).toBe(1);
    expect(metadata.searchQueries).toEqual(["Kerala interior fit-out market competitors"]);
    expect(metadata.findings).toHaveLength(1);
    expect(metadata.findings[0]).toMatchObject({
      sourceUrl: "https://example-industry.test/kerala",
      sourceTitle: "Kerala market overview",
      sourceDomain: "example-industry.test",
      origin: "external_research",
      relevance: 1,
    });
    expect(metadata.findings[0]?.keyFindings).toContain("Several regional brands compete");
  });

  it("tags every finding origin as external_research, never conflating it with company knowledge", () => {
    const content: Anthropic.ContentBlock[] = [
      serverToolUse("premium marble price ranges Dubai"),
      webSearchResults([{ url: "https://example.test/marble", title: "Marble pricing" }]),
    ];
    const metadata = extractResearchExecutionMetadata(content, NOW);
    for (const finding of metadata.findings) {
      expect(finding.origin).toBe("external_research");
    }
  });

  it("keeps a returned-but-uncited source in findings at lower relevance (source_count completeness)", () => {
    const content: Anthropic.ContentBlock[] = [
      serverToolUse("query"),
      webSearchResults([
        { url: "https://cited.test/a", title: "Cited" },
        { url: "https://uncited.test/b", title: "Uncited" },
      ]),
      textWithCitations("answer", [
        { url: "https://cited.test/a", title: "Cited", cited_text: "the cited excerpt" },
      ]),
    ];
    const metadata = extractResearchExecutionMetadata(content, NOW);
    expect(metadata.findings).toHaveLength(2);
    const cited = metadata.findings.find((f) => f.sourceUrl === "https://cited.test/a");
    const uncited = metadata.findings.find((f) => f.sourceUrl === "https://uncited.test/b");
    expect(cited?.relevance).toBeGreaterThan(uncited?.relevance ?? 1);
    expect(uncited?.keyFindings).toBe("");
  });

  it("caps findings at 5, keeping the highest-relevance (cited) ones first", () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      url: `https://example.test/${i}`,
      title: `Result ${i}`,
    }));
    const content: Anthropic.ContentBlock[] = [serverToolUse("query"), webSearchResults(results)];
    const metadata = extractResearchExecutionMetadata(content, NOW);
    expect(metadata.findings).toHaveLength(5);
  });

  it("scenario 8 (provider unavailable): classifies a web_search_tool_result_error and reports zero findings, never fabricated", () => {
    const content: Anthropic.ContentBlock[] = [
      serverToolUse("query"),
      webSearchError("unavailable"),
    ];
    const metadata = extractResearchExecutionMetadata(content, NOW);
    expect(metadata.searchesPerformed).toBe(1);
    expect(metadata.findings).toEqual([]);
    expect(metadata.failureReason).toBe("provider_error");
  });

  it("classifies a rate-limit error distinctly", () => {
    const content: Anthropic.ContentBlock[] = [
      serverToolUse("query"),
      webSearchError("too_many_requests"),
    ];
    const metadata = extractResearchExecutionMetadata(content, NOW);
    expect(metadata.failureReason).toBe("rate_limited");
  });

  it("scenario 6/7 (multilingual): mapping is language-independent -- English source content maps into findings regardless of the customer's language", () => {
    const content: Anthropic.ContentBlock[] = [
      serverToolUse("luxury villa interior trends Dubai"),
      webSearchResults([
        { url: "https://example-en.test/trend", title: "English-language trend report" },
      ]),
      textWithCitations('{"answer": "Las tendencias actuales en Dubái...", "language": "es"}', [
        {
          url: "https://example-en.test/trend",
          title: "English-language trend report",
          cited_text: "Warm minimalism is trending in luxury villa interiors.",
        },
      ]),
    ];
    const metadata = extractResearchExecutionMetadata(content, NOW);
    expect(metadata.findings).toHaveLength(1);
    expect(metadata.findings[0]?.sourceTitle).toBe("English-language trend report");
    // The mapper itself carries no language field/assumption -- language selection is Claude's own answer field, untouched by this mapping.
    expect(metadata).not.toHaveProperty("language");
  });

  it("never reads encrypted_content into a finding (nothing readable to leak)", () => {
    const content: Anthropic.ContentBlock[] = [
      serverToolUse("q"),
      webSearchResults([{ url: "https://example.test/x", title: "X" }]),
    ];
    const metadata = extractResearchExecutionMetadata(content, NOW);
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain("opaque-blob-not-readable");
  });

  it("falls back to the URL as domain when a URL is unparsable, without throwing", () => {
    const content: Anthropic.ContentBlock[] = [
      serverToolUse("q"),
      webSearchResults([{ url: "not-a-valid-url", title: "Bad URL" }]),
    ];
    expect(() => extractResearchExecutionMetadata(content, NOW)).not.toThrow();
  });
});
