import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsTextToSpeechProvider } from "../src/providers/elevenLabsTtsProvider.js";

describe("ElevenLabsTextToSpeechProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchReturningAudio(bytes: number[]) {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("requests opus output from the configured default voice and model", async () => {
    const fetchMock = stubFetchReturningAudio([1, 2, 3]);

    const provider = new ElevenLabsTextToSpeechProvider({
      apiKey: "test-key",
      defaultVoiceId: "default-voice",
      modelId: "eleven_multilingual_v2",
    });

    const result = await provider.synthesize({ text: "hello", languageCode: "en" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/default-voice?output_format=opus_48000_128",
    );
    const init = requestInit as RequestInit;
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("hello");
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body.voice_settings).toBeUndefined();

    expect(new Uint8Array(result.audio)).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.mimeType).toBe("audio/ogg");
  });

  it("uses the per-call voiceId override instead of the default when provided", async () => {
    const fetchMock = stubFetchReturningAudio([1]);
    const provider = new ElevenLabsTextToSpeechProvider({
      apiKey: "test-key",
      defaultVoiceId: "default-voice",
      modelId: "eleven_multilingual_v2",
    });

    await provider.synthesize({ text: "hello", languageCode: "en", voiceId: "custom-voice" });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/text-to-speech/custom-voice");
  });

  it("passes speakingRate through as voice_settings.speed when provided", async () => {
    const fetchMock = stubFetchReturningAudio([1]);
    const provider = new ElevenLabsTextToSpeechProvider({
      apiKey: "test-key",
      defaultVoiceId: "default-voice",
      modelId: "eleven_multilingual_v2",
    });

    await provider.synthesize({ text: "hello", languageCode: "en", speakingRate: 1.2 });

    const [, requestInit] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((requestInit as RequestInit).body as string);
    expect(body.voice_settings).toEqual({ speed: 1.2 });
  });

  it("throws with the response body when the request fails", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "invalid api key",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ElevenLabsTextToSpeechProvider({
      apiKey: "bad-key",
      defaultVoiceId: "default-voice",
      modelId: "eleven_multilingual_v2",
    });

    await expect(provider.synthesize({ text: "hello", languageCode: "en" })).rejects.toThrow(
      "ElevenLabs text-to-speech request failed with status 401: invalid api key",
    );
  });
});
