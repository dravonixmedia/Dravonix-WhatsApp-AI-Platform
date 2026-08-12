import type { WebResearchProvider } from "./provider.js";
import type { RawSearchResult } from "./types.js";

export type MockSearchResponder = (query: string) => RawSearchResult[];

/**
 * Deterministic web research provider for tests and Phase 1 development --
 * no real HTTP call is ever made. Mirrors MockAiProvider's shape (records
 * calls, defaults to a plausible canned response, overridable per test).
 */
export class MockWebResearchProvider implements WebResearchProvider {
  public calls: string[] = [];
  public respond: MockSearchResponder;

  constructor(respond?: MockSearchResponder) {
    this.respond = respond ?? MockWebResearchProvider.defaultResponder;
  }

  static defaultResponder(query: string): RawSearchResult[] {
    const retrievedAt = new Date("2026-08-12T09:00:00.000Z").toISOString();
    return [
      {
        title: `Industry overview: ${query}`,
        url: "https://example-industry-publication.test/overview",
        domain: "example-industry-publication.test",
        snippet: `A recent overview discussing ${query} and related current developments.`,
        publishedAt: "2026-06-01T00:00:00.000Z",
        retrievedAt,
      },
      {
        title: `${query} -- forum discussion`,
        url: "https://example-forum.test/thread/123",
        domain: "example-forum.test",
        snippet: `Community discussion touching on ${query}, mixed quality and unverified claims.`,
        publishedAt: null,
        retrievedAt,
      },
    ];
  }

  async search(query: string): Promise<RawSearchResult[]> {
    this.calls.push(query);
    return this.respond(query);
  }
}
