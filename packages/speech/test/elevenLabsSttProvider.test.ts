import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsSpeechToTextProvider } from "../src/providers/elevenLabsSttProvider.js";

describe("ElevenLabsSpeechToTextProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the audio as multipart form data with the configured model and xi-api-key header", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: "hello there", language_code: "en", language_probability: 0.97 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ElevenLabsSpeechToTextProvider({
      apiKey: "test-key",
      modelId: "scribe_v1",
    });

    const result = await provider.transcribe({
      audio: new ArrayBuffer(4),
      mimeType: "audio/ogg",
      languageCode: "en-US",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    const init = requestInit as RequestInit;
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    const body = init.body as FormData;
    expect(body.get("model_id")).toBe("scribe_v1");

    expect(result).toEqual({
      text: "hello there",
      detectedLanguageCode: "en",
      confidence: 0.97,
    });
  });

  it("trims the transcript and returns null for language/confidence when absent", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: "  padded text  " }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ElevenLabsSpeechToTextProvider({
      apiKey: "test-key",
      modelId: "scribe_v1",
    });
    const result = await provider.transcribe({
      audio: new ArrayBuffer(4),
      mimeType: "audio/ogg",
      languageCode: "en-US",
    });

    expect(result).toEqual({ text: "padded text", detectedLanguageCode: null, confidence: null });
  });

  it("throws with the response body when the request fails", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "invalid api key",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ElevenLabsSpeechToTextProvider({
      apiKey: "bad-key",
      modelId: "scribe_v1",
    });

    await expect(
      provider.transcribe({
        audio: new ArrayBuffer(4),
        mimeType: "audio/ogg",
        languageCode: "en-US",
      }),
    ).rejects.toThrow("ElevenLabs speech-to-text request failed with status 401: invalid api key");
  });

  it("sends language_code only when forceLanguageCode is set (confidently Malayalam)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: "ഹലോ", language_code: "ml", language_probability: 0.99 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ElevenLabsSpeechToTextProvider({
      apiKey: "test-key",
      modelId: "scribe_v2",
    });

    await provider.transcribe({
      audio: new ArrayBuffer(4),
      mimeType: "audio/ogg",
      languageCode: "ml-IN",
      forceLanguageCode: "ml",
    });

    const [, requestInit] = fetchMock.mock.calls[0]!;
    const body = (requestInit as RequestInit).body as FormData;
    expect(body.get("language_code")).toBe("ml");
  });

  it("omits language_code and sends keyterms for auto-detected/mixed-language audio", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: "hello", language_code: "en", language_probability: 0.8 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ElevenLabsSpeechToTextProvider({
      apiKey: "test-key",
      modelId: "scribe_v2",
    });

    await provider.transcribe({
      audio: new ArrayBuffer(4),
      mimeType: "audio/ogg",
      languageCode: "en-US",
      keyterms: ["Dravonix", "branding", "Kerala"],
    });

    const [, requestInit] = fetchMock.mock.calls[0]!;
    const body = (requestInit as RequestInit).body as FormData;
    expect(body.get("language_code")).toBeNull();
    expect(JSON.parse(body.get("keyterms") as string)).toEqual(["Dravonix", "branding", "Kerala"]);
  });

  describe("keyterm sanitization (regression: 2026-08-04 HTTP 400 invalid_keyword_length)", () => {
    it("never sends a keyterm of 50 or more characters, even if the caller supplies one", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ text: "hello", language_code: "en", language_probability: 0.8 }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ElevenLabsSpeechToTextProvider({
        apiKey: "test-key",
        modelId: "scribe_v2",
      });

      // Reproduces the incident shape: one oversized term mixed in with
      // otherwise-valid short terms.
      const oversizedTerm = "a".repeat(60);
      const result = await provider.transcribe({
        audio: new ArrayBuffer(4),
        mimeType: "audio/ogg",
        languageCode: "en-US",
        keyterms: ["Dravonix", oversizedTerm, "Kerala"],
      });

      // The request must still succeed -- a malformed keyterm never fails
      // the transcription.
      expect(result.text).toBe("hello");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [, requestInit] = fetchMock.mock.calls[0]!;
      const body = (requestInit as RequestInit).body as FormData;
      const sentKeyterms = JSON.parse(body.get("keyterms") as string) as string[];
      expect(sentKeyterms).toEqual(["Dravonix", "Kerala"]);
      expect(sentKeyterms.every((term) => term.length < 50)).toBe(true);
    });

    it("omits the keyterms parameter entirely (and still transcribes) when every supplied term is invalid", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ text: "hello", language_code: "en", language_probability: 0.8 }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ElevenLabsSpeechToTextProvider({
        apiKey: "test-key",
        modelId: "scribe_v2",
      });

      const result = await provider.transcribe({
        audio: new ArrayBuffer(4),
        mimeType: "audio/ogg",
        languageCode: "en-US",
        keyterms: ["a".repeat(60), "", "one two three four five six"],
      });

      expect(result.text).toBe("hello");
      const [, requestInit] = fetchMock.mock.calls[0]!;
      const body = (requestInit as RequestInit).body as FormData;
      expect(body.get("keyterms")).toBeNull();
    });
  });
});
