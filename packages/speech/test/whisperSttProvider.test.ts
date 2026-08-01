import { afterEach, describe, expect, it, vi } from "vitest";
import { WhisperSpeechToTextProvider } from "../src/providers/whisperSttProvider.js";

describe("WhisperSpeechToTextProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the audio as multipart form data with the whisper-1 model", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: "hello there", language: "english" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new WhisperSpeechToTextProvider({ apiKey: "test-key" });

    const result = await provider.transcribe({
      audio: new ArrayBuffer(4),
      mimeType: "audio/ogg",
      languageCode: "en-US",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const init = requestInit as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = init.body as FormData;
    expect(body.get("model")).toBe("whisper-1");
    expect(body.get("response_format")).toBe("verbose_json");
    expect(body.has("language")).toBe(false);

    expect(result).toEqual({
      text: "hello there",
      detectedLanguageCode: "english",
      confidence: null,
    });
  });

  it("trims the transcript and returns null for language/confidence when absent", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: "  padded text  " }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new WhisperSpeechToTextProvider({ apiKey: "test-key" });
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

    const provider = new WhisperSpeechToTextProvider({ apiKey: "bad-key" });

    await expect(
      provider.transcribe({
        audio: new ArrayBuffer(4),
        mimeType: "audio/ogg",
        languageCode: "en-US",
      }),
    ).rejects.toThrow("OpenAI Whisper request failed with status 401: invalid api key");
  });
});
