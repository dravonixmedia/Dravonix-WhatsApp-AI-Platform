import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/prompt/buildSystemPrompt.js";
import { RESEARCH_COMPANY_FACT_SEPARATION_POLICY } from "../../src/research/attribution.js";
import { RESEARCH_LANGUAGE_SYNTHESIS_POLICY } from "../../src/research/languagePolicy.js";
import { makeInput } from "../fixtures.js";

describe("buildSystemPrompt -- WEB RESEARCH section (DRAIVA Research staging pilot)", () => {
  it("omits the WEB RESEARCH section entirely when researchEnabled is omitted (default false) -- byte-identical to before this feature existed", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const withDefault = buildSystemPrompt(company, memory, knowledge, temporal);
    const withExplicitFalse = buildSystemPrompt(company, memory, knowledge, temporal, false);
    expect(withDefault).toBe(withExplicitFalse);
    expect(withDefault).not.toContain("WEB RESEARCH");
    expect(withDefault).not.toContain("web_search");
  });

  it("adds a WEB RESEARCH section only when researchEnabled is true", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal, true);
    expect(prompt).toContain("WEB RESEARCH");
    expect(prompt).toContain("web_search");
  });

  it("instructs company-knowledge-first and lists the appropriate research trigger categories", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal, true);
    expect(prompt).toMatch(/First rely on APPROVED COMPANY KNOWLEDGE/);
    expect(prompt).toMatch(/competitor/i);
    expect(prompt).toMatch(/market research/i);
    expect(prompt).toMatch(/latest\/current trends/i);
    expect(prompt).toMatch(/current pricing or ranges/i);
    expect(prompt).toMatch(/current public\s*\n?\s*regulations/i);
  });

  it("explicitly excludes simple company questions from triggering research", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal, true);
    expect(prompt).toMatch(/Do NOT use web_search for simple questions/);
    expect(prompt).toMatch(/business\s*\n?\s*hours/i);
  });

  it("caps web_search to at most once per turn", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal, true);
    expect(prompt).toMatch(/AT MOST ONCE/);
  });

  it("includes the canonical company-fact/research separation policy verbatim", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal, true);
    expect(prompt).toContain(RESEARCH_COMPANY_FACT_SEPARATION_POLICY);
  });

  it("includes the canonical research language-synthesis policy verbatim (no whitelist reintroduced)", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal, true);
    expect(prompt).toContain(RESEARCH_LANGUAGE_SYNTHESIS_POLICY);
  });

  it("instructs concise, WhatsApp-appropriate citations -- no raw URL dumps", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal, true);
    expect(prompt).toMatch(/do not paste multiple raw URLs/i);
  });

  it("instructs honest failure handling -- no fabrication when web_search fails", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal, true);
    expect(prompt).toMatch(/do not\s*\n?\s*fabricate information/i);
    expect(prompt).toMatch(/fall back to company knowledge, or set requiresHuman=true/i);
  });

  it("adjusts the empty-knowledge branch to mention web_search only when research is enabled", () => {
    const { company, memory, temporal } = makeInput();
    const withoutResearch = buildSystemPrompt(company, memory, [], temporal, false);
    const withResearch = buildSystemPrompt(company, memory, [], temporal, true);
    expect(withoutResearch).not.toMatch(/consider using web_search/i);
    expect(withResearch).toMatch(/consider using web_search/i);
    // Both must still forbid fabrication and require requiresHuman for company-specific gaps.
    expect(withoutResearch).toMatch(/Do not invent facts/);
    expect(withResearch).toMatch(/Do not invent facts/);
  });

  it("never introduces a fixed language whitelist inside the research section itself", () => {
    const { company, memory, knowledge, temporal } = makeInput();
    const prompt = buildSystemPrompt(company, memory, knowledge, temporal, true);
    const researchSectionStart = prompt.indexOf("WEB RESEARCH");
    const researchSectionEnd = prompt.indexOf("\n\n", prompt.indexOf("web_search fails"));
    const researchSection = prompt.slice(researchSectionStart, researchSectionEnd);
    // Word-boundary regexes -- a plain substring check would false-positive on
    // "most comm-ONLY ENGLISH-)" hidden inside "most commonly English".
    for (const banned of [/\bonly English\b/, /\bonly Malayalam\b/, /\bEnglish or Malayalam\b/]) {
      expect(researchSection).not.toMatch(banned);
    }
  });
});
