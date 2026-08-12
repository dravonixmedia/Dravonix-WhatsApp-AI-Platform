import { describe, expect, it } from "vitest";
import { evaluateResearchEligibility } from "../../src/research/eligibility.js";
import { executeBoundedResearch, ResearchCallBudget } from "../../src/research/boundedExecution.js";
import { MockWebResearchProvider } from "../../src/research/mockProvider.js";
import { webResearchToolInputSchema } from "../../src/research/webResearchTool.js";
import { sanitizeResearchQuery } from "../../src/research/querySanitizer.js";
import { buildResearchAuditRecord } from "../../src/research/auditContext.js";
import type { RawSearchResult } from "../../src/research/types.js";

/**
 * Representative Phase 1 scenario from the task brief:
 *
 *   Customer: "Can you research the Kerala market for competing interior
 *   fit-out brands?"
 *
 * Expected: the architecture recognizes and can carry out a bounded research
 * round trip end to end (eligibility -> sanitized tool input -> provider ->
 * ranking -> synthesis -> audit metadata) using ONLY the mock provider --
 * no real web call occurs anywhere in this phase (WebResearchProvider has no
 * concrete HTTP implementation yet; see provider.ts).
 */
describe("Kerala interior fit-out market research scenario (Phase 1, mock-only)", () => {
  const customerQuestion =
    "Can you research the Kerala market for competing interior fit-out brands?";
  const companyId = "company-nakshatra";
  const conversationId = "conversation-kerala-1";
  const contactId = "contact-98765";

  it("recognizes the turn as eligible for research when company knowledge cannot answer it", () => {
    const eligibility = evaluateResearchEligibility({ knowledge: [], researchEnabled: true });
    expect(eligibility.decision).toBe("eligible_for_model_decision");
  });

  it("carries out exactly one bounded, sanitized, mock-only research round trip and produces separated findings", async () => {
    // Step 1: the model (simulated here, no real Claude call in this phase)
    // would have decided to call web_research with a public, topic-only
    // query -- validate that shape first.
    const toolInput = webResearchToolInputSchema.parse({
      query: "Kerala interior fit-out market competing brands",
    });

    // Step 2: sanitize against this turn's private context before it could
    // ever reach a provider.
    const sanitized = sanitizeResearchQuery(toolInput.query, {
      companyId,
      conversationId,
      contactId,
    });
    expect(sanitized.safe).toBe(true);

    // Step 3: execute the bounded round trip against the MOCK provider only.
    const provider = new MockWebResearchProvider((query) => {
      const retrievedAt = "2026-08-12T09:00:00.000Z";
      const fixture: RawSearchResult[] = [
        {
          title: "Kerala interior fit-out industry overview",
          url: "https://example-industry-publication.test/kerala-fitout",
          domain: "example-industry-publication.test",
          snippet: `Overview of competing interior fit-out brands active in Kerala, relevant to: ${query}`,
          publishedAt: "2026-05-01T00:00:00.000Z",
          retrievedAt,
        },
      ];
      return fixture;
    });
    const budget = new ResearchCallBudget();

    const result = await executeBoundedResearch({
      rawQuery: toolInput.query,
      sanitizationContext: { companyId, conversationId, contactId },
      provider,
      budget,
      now: new Date("2026-08-12T09:00:00.000Z"),
    });

    expect(result.success).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.origin).toBe("external_research");

    // No real web call: the only "provider" exercised is the deterministic mock.
    expect(provider.calls).toHaveLength(1);
    expect(provider).toBeInstanceOf(MockWebResearchProvider);

    // Step 4: a second attempt within the same turn must be refused (bounded execution).
    const second = await executeBoundedResearch({
      rawQuery: "a follow-up research attempt",
      provider,
      budget,
      now: new Date("2026-08-12T09:00:00.000Z"),
    });
    expect(second.success).toBe(false);
    expect(second.failureReason).toBe("call_limit_exceeded");
    expect(provider.calls).toHaveLength(1);

    // Step 5: the resulting audit metadata is tenant-scoped to this exact company/conversation.
    const audit = buildResearchAuditRecord({ companyId, conversationId }, result);
    expect(audit.companyId).toBe(companyId);
    expect(audit.conversationId).toBe(conversationId);
    expect(audit.sourceCount).toBe(result.findings.length);
  });

  it("never lets the raw customer message (with its own phrasing) leak into the provider call unsanitized", async () => {
    const provider = new MockWebResearchProvider();
    const budget = new ResearchCallBudget();

    await executeBoundedResearch({
      rawQuery: customerQuestion,
      sanitizationContext: { conversationId, contactId },
      provider,
      budget,
      now: new Date("2026-08-12T09:00:00.000Z"),
    });

    // The customer's literal question contains no private data in this
    // example, so sanitization leaves the topic text intact -- the
    // contract this scenario proves is that IF private context had been
    // present it would have been stripped (see querySanitizer.test.ts /
    // boundedExecution.test.ts for that assertion), not that the topic
    // itself is rewritten.
    expect(provider.calls[0]).toContain("Kerala");
    expect(provider.calls[0]).not.toContain(conversationId);
    expect(provider.calls[0]).not.toContain(contactId);
  });
});
