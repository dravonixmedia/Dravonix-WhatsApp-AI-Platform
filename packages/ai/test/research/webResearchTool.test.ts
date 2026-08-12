import { describe, expect, it } from "vitest";
import {
  WEB_RESEARCH_TOOL_DEFINITION,
  WEB_RESEARCH_TOOL_NAME,
  webResearchToolInputSchema,
} from "../../src/research/webResearchTool.js";

describe("WEB_RESEARCH_TOOL_DEFINITION", () => {
  it("is named web_research", () => {
    expect(WEB_RESEARCH_TOOL_DEFINITION.name).toBe(WEB_RESEARCH_TOOL_NAME);
    expect(WEB_RESEARCH_TOOL_DEFINITION.name).toBe("web_research");
  });

  it("requires only a minimal `query` input", () => {
    expect(WEB_RESEARCH_TOOL_DEFINITION.input_schema.required).toEqual(["query"]);
    expect(Object.keys(WEB_RESEARCH_TOOL_DEFINITION.input_schema.properties)).toEqual(["query"]);
  });

  it("instructs against including a phone number", () => {
    expect(WEB_RESEARCH_TOOL_DEFINITION.description).toMatch(/phone number/i);
  });

  it("instructs against including internal IDs", () => {
    expect(WEB_RESEARCH_TOOL_DEFINITION.description).toMatch(/internal .*ID/i);
  });

  it("instructs against including private conversation history", () => {
    expect(WEB_RESEARCH_TOOL_DEFINITION.description).toMatch(/private conversation history/i);
  });

  it("instructs against including credentials", () => {
    expect(WEB_RESEARCH_TOOL_DEFINITION.description).toMatch(/credentials/i);
  });

  it("instructs against including private customer documents", () => {
    expect(WEB_RESEARCH_TOOL_DEFINITION.description).toMatch(/private customer documents/i);
  });

  it("instructs the model to formulate a public research query", () => {
    expect(WEB_RESEARCH_TOOL_DEFINITION.description).toMatch(/public.*(search|research) query/i);
  });

  it("instructs a hard cap of one call per customer turn", () => {
    expect(WEB_RESEARCH_TOOL_DEFINITION.description).toMatch(/at most once per customer turn/i);
  });
});

describe("webResearchToolInputSchema", () => {
  it("accepts a well-formed input", () => {
    const result = webResearchToolInputSchema.safeParse({ query: "villa interior trends Dubai" });
    expect(result.success).toBe(true);
  });

  it("rejects a missing query", () => {
    expect(webResearchToolInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty/too-short query", () => {
    expect(webResearchToolInputSchema.safeParse({ query: "a" }).success).toBe(false);
  });

  it("rejects extra unexpected shapes gracefully (no throw)", () => {
    expect(() => webResearchToolInputSchema.safeParse({ query: 123 })).not.toThrow();
    expect(webResearchToolInputSchema.safeParse({ query: 123 }).success).toBe(false);
  });
});
