import { describe, expect, it, vi } from "vitest";
import { generateValidatedResponse } from "../src/orchestrate.js";
import { MockAiProvider } from "../src/providers/mockProvider.js";
import { makeInput } from "./fixtures.js";

describe("generateValidatedResponse", () => {
  it("returns a valid structured response on the first attempt without repairing", async () => {
    const provider = new MockAiProvider();
    const result = await generateValidatedResponse({ provider }, makeInput());

    expect(result.repaired).toBe(false);
    expect(result.usedFallback).toBe(false);
    expect(result.response.answer).toContain("Dravonix Media");
    expect(provider.calls).toHaveLength(1);
  });

  it("repairs an invalid first response and succeeds on the second attempt", async () => {
    let call = 0;
    const provider = new MockAiProvider(() => {
      call += 1;
      if (call === 1) return "not valid json at all";
      return JSON.stringify({
        answer: "Repaired answer",
        language: "en",
        intent: "general_enquiry",
        confidence: 0.7,
        replyMode: "auto",
        leadUpdates: null,
        requiresHuman: false,
        handoverReason: null,
        knowledgeSourceIds: [],
        internalNotes: null,
      });
    });

    const result = await generateValidatedResponse({ provider }, makeInput());

    expect(result.repaired).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.response.answer).toBe("Repaired answer");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.repairInstruction).toBeDefined();
  });

  it("falls back to a safe static response when both attempts are invalid, and notifies onValidationFailure", async () => {
    const provider = new MockAiProvider(() => "still not valid json");
    const onValidationFailure = vi.fn();

    const result = await generateValidatedResponse({ provider, onValidationFailure }, makeInput());

    expect(result.usedFallback).toBe(true);
    expect(result.response.requiresHuman).toBe(true);
    // The corrected fallback text replaces the old unauthorized time promise
    // (see fallbackMessage.ts) -- it must never resurface here.
    expect(result.response.answer).toBe(
      "I couldn't complete that request automatically. I've shared it with the Dravonix Media team for assistance.",
    );
    expect(result.response.answer).not.toContain("respond as soon as possible");
    expect(onValidationFailure).toHaveBeenCalledTimes(1);
  });

  it("never surfaces raw JSON as the customer-facing answer even when both attempts fail", async () => {
    const provider = new MockAiProvider(() => "{ this is not json");
    const result = await generateValidatedResponse({ provider }, makeInput());
    expect(result.response.answer).not.toContain("{");
  });

  it("sums usage across both the original and repair attempts", async () => {
    const provider = new MockAiProvider(() => "invalid");
    const result = await generateValidatedResponse({ provider }, makeInput());
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(100);
  });

  it("parses a valid response even when wrapped in a markdown code fence", async () => {
    const validResponse = {
      answer: "Fenced answer",
      language: "en",
      intent: "general_enquiry",
      confidence: 0.8,
      replyMode: "auto",
      leadUpdates: null,
      requiresHuman: false,
      handoverReason: null,
      knowledgeSourceIds: [],
      internalNotes: null,
    };
    const provider = new MockAiProvider(
      () => "```json\n" + JSON.stringify(validResponse) + "\n```",
    );

    const result = await generateValidatedResponse({ provider }, makeInput());

    expect(result.usedFallback).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.response.answer).toBe("Fenced answer");
    expect(provider.calls).toHaveLength(1);
  });

  it("parses a valid response even with stray prose before and after the JSON object", async () => {
    const validResponse = {
      answer: "Prose-wrapped answer",
      language: "en",
      intent: "general_enquiry",
      confidence: 0.8,
      replyMode: "auto",
      leadUpdates: null,
      requiresHuman: false,
      handoverReason: null,
      knowledgeSourceIds: [],
      internalNotes: null,
    };
    const provider = new MockAiProvider(
      () =>
        "Here is my response:\n" + JSON.stringify(validResponse) + "\nLet me know if that helps!",
    );

    const result = await generateValidatedResponse({ provider }, makeInput());

    expect(result.usedFallback).toBe(false);
    expect(result.response.answer).toBe("Prose-wrapped answer");
  });

  it("does not repair (and reports low confidence) when the model itself signals low confidence", async () => {
    const provider = new MockAiProvider(() =>
      JSON.stringify({
        answer: "I'm not fully sure, let me connect you with our team.",
        language: "en",
        intent: "unclear",
        confidence: 0.2,
        replyMode: "auto",
        leadUpdates: null,
        requiresHuman: true,
        handoverReason: "low_confidence",
        knowledgeSourceIds: [],
        internalNotes: null,
      }),
    );

    const result = await generateValidatedResponse({ provider }, makeInput());
    expect(result.repaired).toBe(false);
    expect(result.response.requiresHuman).toBe(true);
    expect(result.response.confidence).toBeLessThan(0.55);
  });

  describe("Malayalam and mixed-language responses (validation is language-agnostic)", () => {
    const malayalamAnswer =
      "നിങ്ങളുടെ ചോദ്യത്തിന് നന്ദി. ഞങ്ങൾ വെബ്സൈറ്റ് ഡെവലപ്മെന്റ് സേവനങ്ങൾ വാഗ്ദാനം ചെയ്യുന്നു.";
    const mixedAnswer = "നന്ദി! We offer website development and AI automation services.";

    it("accepts a complete, well-formed Malayalam Unicode response on the first attempt", async () => {
      const provider = new MockAiProvider(() =>
        JSON.stringify({
          answer: malayalamAnswer,
          language: "ml",
          intent: "general_enquiry",
          confidence: 0.85,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: false,
          handoverReason: null,
          knowledgeSourceIds: [],
          internalNotes: null,
        }),
      );

      const result = await generateValidatedResponse({ provider }, makeInput());

      expect(result.usedFallback).toBe(false);
      expect(result.repaired).toBe(false);
      expect(result.response.answer).toBe(malayalamAnswer);
      expect(result.response.language).toBe("ml");
    });

    it("accepts Malayalam-English mixed-script text in the same response", async () => {
      const provider = new MockAiProvider(() =>
        JSON.stringify({
          answer: mixedAnswer,
          language: "ml",
          intent: "general_enquiry",
          confidence: 0.8,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: false,
          handoverReason: null,
          knowledgeSourceIds: [],
          internalNotes: null,
        }),
      );

      const result = await generateValidatedResponse({ provider }, makeInput());

      expect(result.usedFallback).toBe(false);
      expect(result.response.answer).toBe(mixedAnswer);
    });

    it("preserves the detected language in the repair instruction sent to the provider", async () => {
      let call = 0;
      const provider = new MockAiProvider(() => {
        call += 1;
        if (call === 1) return "{ malformed";
        return JSON.stringify({
          answer: malayalamAnswer,
          language: "ml",
          intent: "general_enquiry",
          confidence: 0.7,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: false,
          handoverReason: null,
          knowledgeSourceIds: [],
          internalNotes: null,
        });
      });

      const result = await generateValidatedResponse(
        { provider },
        makeInput({ currentDetectedLanguage: "ml" }),
      );

      expect(result.repaired).toBe(true);
      expect(result.response.answer).toBe(malayalamAnswer);
      expect(provider.calls[1]?.repairInstruction).toContain("ml");
    });

    it("extracts and validates a Malayalam response wrapped in a markdown code fence", async () => {
      const validResponse = {
        answer: malayalamAnswer,
        language: "ml",
        intent: "general_enquiry",
        confidence: 0.8,
        replyMode: "auto",
        leadUpdates: null,
        requiresHuman: false,
        handoverReason: null,
        knowledgeSourceIds: [],
        internalNotes: null,
      };
      const provider = new MockAiProvider(
        () =>
          "Here is my response:\n```json\n" + JSON.stringify(validResponse) + "\n```\nLet me know!",
      );

      const result = await generateValidatedResponse({ provider }, makeInput());

      expect(result.usedFallback).toBe(false);
      expect(result.repaired).toBe(false);
      expect(result.response.answer).toBe(malayalamAnswer);
    });

    it("emits sanitized diagnostics for each parse attempt, with no raw transcript/response content", async () => {
      let call = 0;
      const provider = new MockAiProvider(() => {
        call += 1;
        if (call === 1) return "{ not valid json";
        return JSON.stringify({
          answer: malayalamAnswer,
          language: "ml",
          intent: "general_enquiry",
          confidence: 0.7,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: false,
          handoverReason: null,
          knowledgeSourceIds: [],
          internalNotes: null,
        });
      });
      const events: unknown[] = [];

      await generateValidatedResponse(
        { provider, onDiagnostics: (e) => events.push(e) },
        makeInput({ currentDetectedLanguage: "ml", customerMessage: malayalamAnswer }),
      );

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        stage: "claude_response_parse",
        attempt: "first",
        detectedLanguage: "ml",
        category: "response_json_parse_failed",
        failedField: null,
        repairAttempted: false,
        repairSucceeded: null,
      });
      expect(events[1]).toMatchObject({
        stage: "claude_response_parse",
        attempt: "repair",
        detectedLanguage: "ml",
        category: null,
        repairAttempted: true,
        repairSucceeded: true,
      });
      // Only counts, never the actual transcript/response text.
      for (const event of events) {
        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain(malayalamAnswer);
        expect(typeof (event as { transcriptCharCount: number }).transcriptCharCount).toBe(
          "number",
        );
        expect(typeof (event as { responseCharCount: number }).responseCharCount).toBe("number");
      }
    });

    it("reports the exact schema field that failed when JSON parses but a field is invalid", async () => {
      const provider = new MockAiProvider(() =>
        JSON.stringify({
          answer: malayalamAnswer,
          // language is missing entirely -- a schema violation, not a parse error.
          intent: "general_enquiry",
          confidence: 0.7,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: false,
          handoverReason: null,
          knowledgeSourceIds: [],
          internalNotes: null,
        }),
      );
      const events: unknown[] = [];

      await generateValidatedResponse(
        { provider, onDiagnostics: (e) => events.push(e) },
        makeInput(),
      );

      expect(events[0]).toMatchObject({
        category: "response_schema_validation_failed",
        failedField: "language",
      });
    });

    it("falls back to the Malayalam safe-fallback text when both attempts fail for a Malayalam turn, and still escalates", async () => {
      const provider = new MockAiProvider(() => "still not valid json");

      const result = await generateValidatedResponse(
        { provider },
        makeInput({
          currentDetectedLanguage: "ml",
          company: {
            ...makeInput().company,
            staticFallbackMessage:
              "Automated assistance is temporarily unavailable. Our team will respond as soon as possible.",
          },
        }),
      );

      expect(result.usedFallback).toBe(true);
      expect(result.response.requiresHuman).toBe(true);
      expect(result.response.handoverReason).toBe("ai_response_validation_failed");
      expect(result.response.answer).not.toContain("respond as soon as possible");
      expect(result.response.answer).toMatch(/[ഀ-ൿ]/);
    });

    it("emits a final response_repair_failed diagnostic distinct from the per-attempt category", async () => {
      const provider = new MockAiProvider(() => "not valid json at all");
      const events: unknown[] = [];

      await generateValidatedResponse(
        { provider, onDiagnostics: (e) => events.push(e) },
        makeInput(),
      );

      const categories = (events as Array<{ category: string | null }>).map((e) => e.category);
      expect(categories).toEqual([
        "response_json_parse_failed", // first attempt
        "response_json_parse_failed", // repair attempt
        "response_repair_failed", // final summary marker
      ]);
    });

    it("emits response_safety_validation_failed, distinct from a parse/schema failure, when safety rules force an escalation", async () => {
      const provider = new MockAiProvider(() =>
        JSON.stringify({
          answer: "Our website package costs ₹25,000.",
          language: "en",
          intent: "pricing_question",
          confidence: 0.8,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: false, // Claude did not ask for a handover itself
          handoverReason: null,
          knowledgeSourceIds: [], // no grounding cited for a pricing claim
          internalNotes: null,
        }),
      );
      const events: unknown[] = [];

      const result = await generateValidatedResponse(
        { provider, onDiagnostics: (e) => events.push(e) },
        makeInput(),
      );

      expect(result.response.requiresHuman).toBe(true);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ category: null }); // the parse/schema step itself succeeded
      expect(events[1]).toMatchObject({
        stage: "claude_response_safety",
        category: "response_safety_validation_failed",
      });
    });

    it("includes the specific validation error and the required schema in the repair instruction, not a vague message", async () => {
      let call = 0;
      const provider = new MockAiProvider(() => {
        call += 1;
        if (call === 1) {
          return JSON.stringify({
            answer: "Hi there",
            // language omitted -- triggers a schema_validation_failed on "language"
            intent: "general_enquiry",
            confidence: 0.7,
            replyMode: "auto",
            leadUpdates: null,
            requiresHuman: false,
            handoverReason: null,
            knowledgeSourceIds: [],
            internalNotes: null,
          });
        }
        return JSON.stringify({
          answer: "Hi there",
          language: "en",
          intent: "general_enquiry",
          confidence: 0.7,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: false,
          handoverReason: null,
          knowledgeSourceIds: [],
          internalNotes: null,
        });
      });

      await generateValidatedResponse({ provider }, makeInput());

      const repairInstruction = provider.calls[1]?.repairInstruction ?? "";
      expect(repairInstruction).toContain("language");
      expect(repairInstruction).toContain("requiresHuman");
      expect(repairInstruction).toContain("handoverReason");
    });
  });
});
