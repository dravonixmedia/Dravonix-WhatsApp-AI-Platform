import { describe, expect, it } from "vitest";
import {
  isDraftAction,
  resolveTranslateSource,
  resolveTranslateSourceText,
} from "../lib/chatAgentTranslate.js";

describe("resolveTranslateSource: priority and override", () => {
  it("prefers the reply composer when it has text, even if an AI draft also exists", () => {
    expect(resolveTranslateSource("Hello there", "Suggested reply text", null)).toBe("composer");
  });

  it("falls back to the latest AI draft when the composer is empty", () => {
    expect(resolveTranslateSource("", "Suggested reply text", null)).toBe("draft");
    expect(resolveTranslateSource("   ", "Suggested reply text", null)).toBe("draft");
  });

  it("returns null when neither the composer nor an AI draft has text", () => {
    expect(resolveTranslateSource("", null, null)).toBeNull();
    expect(resolveTranslateSource("   ", "   ", null)).toBeNull();
  });

  it("honors a manual override to the draft even though the composer has priority by default", () => {
    expect(resolveTranslateSource("Hello there", "Suggested reply text", "draft")).toBe("draft");
  });

  it("honors a manual override to the composer explicitly", () => {
    expect(resolveTranslateSource("Hello there", "Suggested reply text", "composer")).toBe(
      "composer",
    );
  });

  it("ignores a stale override pointing at a source that no longer has text, falling back to priority", () => {
    // User previously chose "draft", but the draft was since cleared/never existed.
    expect(resolveTranslateSource("Hello there", null, "draft")).toBe("composer");
    // User previously chose "composer", but it was cleared -- falls back to the draft.
    expect(resolveTranslateSource("", "Suggested reply text", "composer")).toBe("draft");
  });
});

describe("resolveTranslateSourceText", () => {
  it("returns the composer text when source is composer", () => {
    expect(resolveTranslateSourceText("composer", "Hello there", "Some draft")).toBe("Hello there");
  });

  it("returns the AI draft text when source is draft", () => {
    expect(resolveTranslateSourceText("draft", "Hello there", "Some draft")).toBe("Some draft");
  });

  it("returns an empty string when source is null (no valid source)", () => {
    expect(resolveTranslateSourceText(null, "Hello there", "Some draft")).toBe("");
  });

  it("returns an empty string when source is draft but there is no draft text", () => {
    expect(resolveTranslateSourceText("draft", "Hello there", null)).toBe("");
  });
});

describe("isDraftAction: which actions count as a customer-ready draft", () => {
  it("suggest_reply, rewrite_draft, translate, and prepare_follow_up are draft actions", () => {
    expect(isDraftAction("suggest_reply")).toBe(true);
    expect(isDraftAction("rewrite_draft")).toBe(true);
    expect(isDraftAction("translate")).toBe(true);
    expect(isDraftAction("prepare_follow_up")).toBe(true);
  });

  it("summarize, extract_lead, and ask_question are never draft actions -- informational only", () => {
    expect(isDraftAction("summarize")).toBe(false);
    expect(isDraftAction("extract_lead")).toBe(false);
    expect(isDraftAction("ask_question")).toBe(false);
  });
});
