import { describe, expect, it } from "vitest";
import {
  MockSpeechToTextProvider,
  MockTextToSpeechProvider,
} from "../src/providers/mockProvider.js";

describe("MockSpeechToTextProvider", () => {
  it("returns a deterministic transcription echoing the requested language", async () => {
    const provider = new MockSpeechToTextProvider();
    const result = await provider.transcribe({
      audio: new ArrayBuffer(0),
      mimeType: "audio/ogg",
      languageCode: "ml-IN",
    });
    expect(result.detectedLanguageCode).toBe("ml-IN");
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe("MockTextToSpeechProvider", () => {
  it("returns OGG-labeled audio output without any network call", async () => {
    const provider = new MockTextToSpeechProvider();
    const result = await provider.synthesize({ text: "Hello", languageCode: "en" });
    expect(result.mimeType).toBe("audio/ogg");
    expect(new TextDecoder().decode(result.audio)).toContain("Hello");
  });
});
