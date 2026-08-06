import { describe, expect, it } from "vitest";
import {
  isDraftAction,
  resolveDefaultTargetLanguage,
  resolveTranslateSource,
  resolveTranslateSourceText,
} from "../lib/chatAgentTranslate.js";

describe("resolveTranslateSource: priority and override across composer/draft/result", () => {
  it("prefers the reply composer when it has text, even if an AI draft and an assistant result also exist", () => {
    expect(
      resolveTranslateSource("Hello there", "Suggested reply text", "Summary text", null),
    ).toBe("composer");
  });

  it("falls back to the latest AI draft when the composer is empty but a draft exists", () => {
    expect(resolveTranslateSource("", "Suggested reply text", "Summary text", null)).toBe("draft");
    expect(resolveTranslateSource("   ", "Suggested reply text", null, null)).toBe("draft");
  });

  it("falls back to the latest assistant result when neither the composer nor a draft has text", () => {
    expect(resolveTranslateSource("", null, "Summary text", null)).toBe("result");
    expect(resolveTranslateSource("   ", "   ", "Summary text", null)).toBe("result");
  });

  it("returns null when none of the three sources has text", () => {
    expect(resolveTranslateSource("", null, null, null)).toBeNull();
    expect(resolveTranslateSource("   ", "   ", "   ", null)).toBeNull();
  });

  it("honors a manual override to the draft even though the composer has priority by default", () => {
    expect(resolveTranslateSource("Hello there", "Suggested reply text", null, "draft")).toBe(
      "draft",
    );
  });

  it("honors a manual override to the assistant result even though the composer/draft have priority by default", () => {
    expect(
      resolveTranslateSource("Hello there", "Suggested reply text", "Summary text", "result"),
    ).toBe("result");
  });

  it("honors a manual override to the composer explicitly", () => {
    expect(resolveTranslateSource("Hello there", "Suggested reply text", null, "composer")).toBe(
      "composer",
    );
  });

  it("ignores a stale override pointing at a source that no longer has text, falling back to priority", () => {
    // User previously chose "draft", but the draft was since cleared/never existed.
    expect(resolveTranslateSource("Hello there", null, null, "draft")).toBe("composer");
    // User previously chose "composer", but it was cleared -- falls back to the draft.
    expect(resolveTranslateSource("", "Suggested reply text", null, "composer")).toBe("draft");
    // User previously chose "result", but it was cleared and there is no draft either -- falls back to composer.
    expect(resolveTranslateSource("Hello there", null, null, "result")).toBe("composer");
  });
});

describe("resolveTranslateSourceText", () => {
  it("returns the composer text when source is composer", () => {
    expect(resolveTranslateSourceText("composer", "Hello there", "Some draft", "Some result")).toBe(
      "Hello there",
    );
  });

  it("returns the AI draft text when source is draft", () => {
    expect(resolveTranslateSourceText("draft", "Hello there", "Some draft", "Some result")).toBe(
      "Some draft",
    );
  });

  it("returns the assistant result text when source is result", () => {
    expect(resolveTranslateSourceText("result", "Hello there", "Some draft", "Some result")).toBe(
      "Some result",
    );
  });

  it("returns an empty string when source is null (no valid source)", () => {
    expect(resolveTranslateSourceText(null, "Hello there", "Some draft", "Some result")).toBe("");
  });

  it("returns an empty string when source is draft but there is no draft text", () => {
    expect(resolveTranslateSourceText("draft", "Hello there", null, "Some result")).toBe("");
  });

  it("returns an empty string when source is result but there is no assistant result text", () => {
    expect(resolveTranslateSourceText("result", "Hello there", "Some draft", null)).toBe("");
  });
});

describe("resolveDefaultTargetLanguage: always picks a target different from the detected source", () => {
  it("defaults an English source to Malayalam", () => {
    expect(resolveDefaultTargetLanguage("en")).toBe("ml");
  });

  it("defaults a Malayalam source to English", () => {
    expect(resolveDefaultTargetLanguage("ml")).toBe("en");
  });

  it("defaults a Hindi source to English", () => {
    expect(resolveDefaultTargetLanguage("hi")).toBe("en");
  });

  it("defaults an Arabic source to English", () => {
    expect(resolveDefaultTargetLanguage("ar")).toBe("en");
  });

  it("defaults an unknown/undetectable (mixed-language) source to English", () => {
    expect(resolveDefaultTargetLanguage(null)).toBe("en");
  });
});

describe("isDraftAction: which actions count as a customer-ready draft", () => {
  it("suggest_reply, rewrite_draft, translate, and prepare_follow_up are draft actions", () => {
    expect(isDraftAction("suggest_reply")).toBe(true);
    expect(isDraftAction("rewrite_draft")).toBe(true);
    expect(isDraftAction("translate")).toBe(true);
    expect(isDraftAction("prepare_follow_up")).toBe(true);
  });

  it("summarize, extract_lead, and ask_question are never draft actions -- they're the 'latest assistant result' bucket instead", () => {
    expect(isDraftAction("summarize")).toBe(false);
    expect(isDraftAction("extract_lead")).toBe(false);
    expect(isDraftAction("ask_question")).toBe(false);
  });
});
