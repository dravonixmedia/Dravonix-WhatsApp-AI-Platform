import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsTextToSpeechProvider } from "../src/providers/elevenLabsTtsProvider.js";
import { ElevenLabsProviderError } from "../src/providers/elevenLabsError.js";

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

  describe("error sanitization and classification (voice pipeline reliability phase 7)", () => {
    it("never includes the raw response body in the thrown error", async () => {
      const sensitiveBody = "Authorization failed for key sk_live_abcdef1234567890";
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => sensitiveBody,
      }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ElevenLabsTextToSpeechProvider({
        apiKey: "bad-key",
        defaultVoiceId: "default-voice",
        modelId: "eleven_multilingual_v2",
      });

      let caught: unknown;
      try {
        await provider.synthesize({ text: "hello", languageCode: "en" });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ElevenLabsProviderError);
      const error = caught as ElevenLabsProviderError;
      expect(error.message).not.toContain("sk_live_abcdef1234567890");
      expect(error.category).toBe("authentication_error");
      expect(error.retryable).toBe(false);
    });

    it("classifies 429 as rate_limited, retryable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status: 429 })),
      );
      const provider = new ElevenLabsTextToSpeechProvider({
        apiKey: "k",
        defaultVoiceId: "default-voice",
        modelId: "eleven_multilingual_v2",
      });
      let caught: unknown;
      try {
        await provider.synthesize({ text: "hello", languageCode: "en" });
      } catch (error) {
        caught = error;
      }
      const error = caught as ElevenLabsProviderError;
      expect(error.category).toBe("rate_limited");
      expect(error.retryable).toBe(true);
    });

    it("wraps a network-level failure as retryable network_error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("network down");
        }),
      );
      const provider = new ElevenLabsTextToSpeechProvider({
        apiKey: "k",
        defaultVoiceId: "default-voice",
        modelId: "eleven_multilingual_v2",
      });
      let caught: unknown;
      try {
        await provider.synthesize({ text: "hello", languageCode: "en" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ElevenLabsProviderError);
      expect((caught as ElevenLabsProviderError).retryable).toBe(true);
    });
  });

  describe("Malayalam-specific voice/model selection", () => {
    function makeProvider() {
      return new ElevenLabsTextToSpeechProvider({
        apiKey: "test-key",
        defaultVoiceId: "default-voice",
        modelId: "eleven_multilingual_v2",
        malayalamVoiceId: "malayalam-voice",
        englishVoiceId: "english-voice",
        malayalamModelId: "eleven_v3",
      });
    }

    it("uses the configured Malayalam voice and eleven_v3 model, with language_code ml, for Malayalam text", async () => {
      const fetchMock = stubFetchReturningAudio([1]);
      const provider = makeProvider();

      await provider.synthesize({ text: "നന്ദി", languageCode: "ml" });

      const [url, requestInit] = fetchMock.mock.calls[0]!;
      expect(url).toContain("/text-to-speech/malayalam-voice");
      const body = JSON.parse((requestInit as RequestInit).body as string);
      expect(body.model_id).toBe("eleven_v3");
      expect(body.language_code).toBe("ml");
    });

    it("uses the configured English voice (and the default model, not eleven_v3) for English text", async () => {
      const fetchMock = stubFetchReturningAudio([1]);
      const provider = makeProvider();

      await provider.synthesize({ text: "Thanks", languageCode: "en" });

      const [url, requestInit] = fetchMock.mock.calls[0]!;
      expect(url).toContain("/text-to-speech/english-voice");
      const body = JSON.parse((requestInit as RequestInit).body as string);
      expect(body.model_id).toBe("eleven_multilingual_v2");
      expect(body.language_code).toBeUndefined();
    });

    it("uses Eleven v3 Natural stability for Malayalam", async () => {
      const fetchMock = stubFetchReturningAudio([1]);
      const provider = makeProvider();

      await provider.synthesize({ text: "നന്ദി", languageCode: "ml" });

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.voice_settings.stability).toBe("natural");
    });

    it("does not apply the Malayalam stability preset to English requests", async () => {
      const fetchMock = stubFetchReturningAudio([1]);
      const provider = makeProvider();

      await provider.synthesize({ text: "Thanks", languageCode: "en" });

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.voice_settings).toBeUndefined();
    });

    it("selects the Malayalam voice for Malayalam-dominant mixed text passed as languageCode ml", async () => {
      // The caller (processVoiceJob) is responsible for deciding "ml" vs "en"
      // based on the reply's actual dominant script -- this provider only
      // needs to honor whatever languageCode it's given.
      const fetchMock = stubFetchReturningAudio([1]);
      const provider = makeProvider();

      await provider.synthesize({
        text: "നിങ്ങളുടെ requirement പറയാമോ? We can help with website and branding.",
        languageCode: "ml",
      });

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toContain("/text-to-speech/malayalam-voice");
    });

    it("attaches the pronunciation dictionary to Malayalam requests when configured", async () => {
      const fetchMock = stubFetchReturningAudio([1]);
      const provider = new ElevenLabsTextToSpeechProvider({
        apiKey: "test-key",
        defaultVoiceId: "default-voice",
        modelId: "eleven_multilingual_v2",
        malayalamVoiceId: "malayalam-voice",
        malayalamModelId: "eleven_v3",
        pronunciationDictionaryId: "dict-123",
        pronunciationDictionaryVersionId: "version-456",
      });

      await provider.synthesize({ text: "നന്ദി", languageCode: "ml" });

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.pronunciation_dictionary_locators).toEqual([
        { pronunciation_dictionary_id: "dict-123", version_id: "version-456" },
      ]);
    });

    it("omits the pronunciation dictionary locator when not configured", async () => {
      const fetchMock = stubFetchReturningAudio([1]);
      const provider = makeProvider();

      await provider.synthesize({ text: "നന്ദി", languageCode: "ml" });

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.pronunciation_dictionary_locators).toBeUndefined();
    });

    it("does not attach a pronunciation dictionary to English requests even when configured", async () => {
      const fetchMock = stubFetchReturningAudio([1]);
      const provider = new ElevenLabsTextToSpeechProvider({
        apiKey: "test-key",
        defaultVoiceId: "default-voice",
        modelId: "eleven_multilingual_v2",
        englishVoiceId: "english-voice",
        pronunciationDictionaryId: "dict-123",
        pronunciationDictionaryVersionId: "version-456",
      });

      await provider.synthesize({ text: "Thanks", languageCode: "en" });

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.pronunciation_dictionary_locators).toBeUndefined();
    });

    it("falls back to defaultVoiceId/modelId when Malayalam/English-specific config is not set", async () => {
      const fetchMock = stubFetchReturningAudio([1]);
      const provider = new ElevenLabsTextToSpeechProvider({
        apiKey: "test-key",
        defaultVoiceId: "default-voice",
        modelId: "eleven_multilingual_v2",
      });

      await provider.synthesize({ text: "നന്ദി", languageCode: "ml" });

      const [url, requestInit] = fetchMock.mock.calls[0]!;
      expect(url).toContain("/text-to-speech/default-voice");
      const body = JSON.parse((requestInit as RequestInit).body as string);
      expect(body.model_id).toBe("eleven_multilingual_v2");
    });

    it("still lets an explicit per-call voiceId override the Malayalam voice", async () => {
      const fetchMock = stubFetchReturningAudio([1]);
      const provider = makeProvider();

      await provider.synthesize({ text: "നന്ദി", languageCode: "ml", voiceId: "explicit-voice" });

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toContain("/text-to-speech/explicit-voice");
    });
  });
});
