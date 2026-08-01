import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleSpeechToTextProvider } from "../src/providers/googleSttProvider.js";

describe("GoogleSpeechToTextProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends sampleRateHertz: 16000 for OGG_OPUS, matching WhatsApp's voice note encoding", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [
          { alternatives: [{ transcript: "hello", confidence: 0.9 }], languageCode: "en-US" },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GoogleSpeechToTextProvider({
      getAccessToken: async () => "token",
    });

    await provider.transcribe({
      audio: new ArrayBuffer(4),
      mimeType: "audio/ogg",
      languageCode: "en-US",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((requestInit as RequestInit).body as string);
    expect(body.config.encoding).toBe("OGG_OPUS");
    expect(body.config.sampleRateHertz).toBe(16000);
  });
});
