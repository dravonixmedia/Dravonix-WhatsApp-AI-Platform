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
});
