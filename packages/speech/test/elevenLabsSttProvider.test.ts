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

  it("omits language_code and sends keyterms as separate multipart entries for auto-detected/mixed-language audio", async () => {
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
    // Each keyterm is its own "keyterms" multipart entry -- the standard
    // list representation for a repeated form field -- never a single
    // JSON.stringify'd blob under one entry.
    expect(body.getAll("keyterms")).toEqual(["Dravonix", "branding", "Kerala"]);
  });

  describe("keyterm sanitization and wire encoding (regression: 2026-08-04 HTTP 400 invalid_keyword_length)", () => {
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
      const sentKeyterms = body.getAll("keyterms") as string[];
      expect(sentKeyterms).toEqual(["Dravonix", "Kerala"]);
      expect(sentKeyterms.every((term) => Array.from(term).length < 50)).toBe(true);
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
      expect(body.getAll("keyterms")).toEqual([]);
      expect(body.get("keyterms")).toBeNull();
    });

    it("never sends the complete JSON array string as a single keyterms value", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ text: "hello", language_code: "en", language_probability: 0.8 }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ElevenLabsSpeechToTextProvider({
        apiKey: "test-key",
        modelId: "scribe_v2",
      });

      const terms = ["Dravonix", "branding", "website", "Zoho", "Kerala"];
      await provider.transcribe({
        audio: new ArrayBuffer(4),
        mimeType: "audio/ogg",
        languageCode: "en-US",
        keyterms: terms,
      });

      const [, requestInit] = fetchMock.mock.calls[0]!;
      const body = (requestInit as RequestInit).body as FormData;
      const sentValues = body.getAll("keyterms") as string[];
      const wouldHaveBeenSentAsBlob = JSON.stringify(terms);

      expect(sentValues).not.toContain(wouldHaveBeenSentAsBlob);
      expect(sentValues.some((value) => value.startsWith("["))).toBe(false);
      expect(sentValues).toHaveLength(terms.length);
    });

    it("represents twelve valid short terms as twelve separate multipart entries, not one combined value", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ text: "hello", language_code: "en", language_probability: 0.8 }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ElevenLabsSpeechToTextProvider({
        apiKey: "test-key",
        modelId: "scribe_v2",
      });

      // Same shape as the real MALAYALAM_STT_KEYTERMS list whose
      // JSON.stringify'd form (120 characters) caused the original incident.
      const twelveTerms = [
        "Dravonix",
        "branding",
        "website",
        "quotation",
        "logo",
        "social media",
        "Zoho",
        "CRM",
        "SaaS",
        "Cloudflare",
        "Supabase",
        "Kerala",
      ];
      const combinedBlobLength = JSON.stringify(twelveTerms).length;
      expect(combinedBlobLength).toBeGreaterThan(50); // sanity check on the fixture itself

      await provider.transcribe({
        audio: new ArrayBuffer(4),
        mimeType: "audio/ogg",
        languageCode: "en-US",
        keyterms: twelveTerms,
      });

      const [, requestInit] = fetchMock.mock.calls[0]!;
      const body = (requestInit as RequestInit).body as FormData;
      const sentValues = body.getAll("keyterms") as string[];

      expect(sentValues).toHaveLength(12);
      expect(sentValues).toEqual(twelveTerms);
      for (const value of sentValues) {
        expect(Array.from(value).length).toBeLessThan(50);
      }
    });

    it("keeps every transmitted term under 50 Unicode characters and at most 5 normalized words", async () => {
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
        keyterms: [
          "Dravonix",
          "a".repeat(60),
          "one two three four five six seven",
          "social media",
          "one two three four five",
        ],
      });

      const [, requestInit] = fetchMock.mock.calls[0]!;
      const body = (requestInit as RequestInit).body as FormData;
      const sentValues = body.getAll("keyterms") as string[];

      expect(sentValues).toEqual(["Dravonix", "social media", "one two three four five"]);
      for (const value of sentValues) {
        expect(Array.from(value).length).toBeLessThan(50);
        expect(value.split(" ").length).toBeLessThanOrEqual(5);
      }
    });

    it("accepts a request containing multiple valid Malayalam and English terms via a mocked ElevenLabs-compatible endpoint", async () => {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        // Simulates an ElevenLabs-compatible server: validates every
        // transmitted "keyterms" entry itself, exactly as the real API does,
        // and only responds 200 if none violate its constraints.
        const body = init.body as FormData;
        const keyterms = body.getAll("keyterms") as string[];
        for (const term of keyterms) {
          if (Array.from(term).length >= 50 || term.split(" ").length > 5) {
            return {
              ok: false,
              status: 400,
              text: async () =>
                JSON.stringify({
                  type: "validation_error",
                  code: "invalid_parameters",
                  status: "invalid_keyword_length",
                  parameter: "keywords",
                  message: "All keywords must be less than 50 characters",
                }),
            };
          }
        }
        return {
          ok: true,
          json: async () => ({ text: "മനസ്സിലായി", language_code: "ml", language_probability: 0.9 }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ElevenLabsSpeechToTextProvider({
        apiKey: "test-key",
        modelId: "scribe_v2",
      });

      const result = await provider.transcribe({
        audio: new ArrayBuffer(4),
        mimeType: "audio/ogg",
        languageCode: "ml-IN",
        keyterms: ["Dravonix", "Kerala", "branding", "website", "Zoho"],
      });

      expect(result.text).toBe("മനസ്സിലായി");
    });

    it("reproduces the original invalid_keyword_length incident against a mocked ElevenLabs-compatible endpoint and confirms it no longer occurs", async () => {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = init.body as FormData;
        const keyterms = body.getAll("keyterms") as string[];
        // The real incident: the entire array was serialized into ONE
        // multipart value, which is what a validator would see if this
        // regression ever reappeared.
        for (const term of keyterms) {
          if (Array.from(term).length >= 50) {
            return {
              ok: false,
              status: 400,
              text: async () =>
                JSON.stringify({
                  type: "validation_error",
                  code: "invalid_parameters",
                  status: "invalid_keyword_length",
                  parameter: "keywords",
                  message: "All keywords must be less than 50 characters",
                }),
            };
          }
        }
        return {
          ok: true,
          json: async () => ({ text: "hello", language_code: "en", language_probability: 0.9 }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ElevenLabsSpeechToTextProvider({
        apiKey: "test-key",
        modelId: "scribe_v2",
      });

      // The exact fixture that used to trigger the 400: a full,
      // valid-looking business-vocabulary list whose old JSON.stringify
      // encoding was 120 characters as one value.
      const incidentShapedTerms = [
        "Dravonix",
        "branding",
        "website",
        "quotation",
        "logo",
        "social media",
        "Zoho",
        "CRM",
        "SaaS",
        "Cloudflare",
        "Supabase",
        "Kerala",
      ];

      const result = await provider.transcribe({
        audio: new ArrayBuffer(4),
        mimeType: "audio/ogg",
        languageCode: "en-US",
        keyterms: incidentShapedTerms,
      });

      // Would previously have rejected with HTTP 400 invalid_keyword_length;
      // now succeeds because every entry is sent (and validated) discretely.
      expect(result.text).toBe("hello");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
