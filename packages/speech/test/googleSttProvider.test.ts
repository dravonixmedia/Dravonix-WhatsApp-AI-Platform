import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleSpeechToTextProvider } from "../src/providers/googleSttProvider.js";

/**
 * Builds a minimal buffer containing an Ogg Opus "OpusHead" ID header (RFC 7845
 * section 5.1) declaring the given input sample rate, preceded by `leadingBytes`
 * of unrelated data (simulating the Ogg page header that precedes it in a real
 * file). Only the fields our parser reads are filled in meaningfully.
 */
function buildOpusHeadBuffer(sampleRateHertz: number, leadingBytes = 28): ArrayBuffer {
  const buffer = new ArrayBuffer(leadingBytes + 19);
  const bytes = new Uint8Array(buffer);
  const magic = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
  bytes.set(magic, leadingBytes);
  const view = new DataView(buffer);
  view.setUint8(leadingBytes + 8, 1); // version
  view.setUint8(leadingBytes + 9, 1); // channels
  view.setUint16(leadingBytes + 10, 312, true); // pre-skip
  view.setUint32(leadingBytes + 12, sampleRateHertz, true); // input sample rate
  return buffer;
}

function stubFetchReturning(transcript: string) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      results: [{ alternatives: [{ transcript, confidence: 0.9 }], languageCode: "en-US" }],
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("GoogleSpeechToTextProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the real input sample rate out of the audio's Ogg Opus header instead of assuming one", async () => {
    const fetchMock = stubFetchReturning("hello");
    const provider = new GoogleSpeechToTextProvider({ getAccessToken: async () => "token" });

    // Confirmed via direct inspection of a real WhatsApp voice note: its Ogg
    // Opus header declares 24000 Hz, not the commonly-assumed 16000 or 48000.
    await provider.transcribe({
      audio: buildOpusHeadBuffer(24000),
      mimeType: "audio/ogg",
      languageCode: "en-US",
    });

    const [, requestInit] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((requestInit as RequestInit).body as string);
    expect(body.config.encoding).toBe("OGG_OPUS");
    expect(body.config.sampleRateHertz).toBe(24000);
  });

  it("falls back to 48000 when no OpusHead header can be found", async () => {
    const fetchMock = stubFetchReturning("hello");
    const provider = new GoogleSpeechToTextProvider({ getAccessToken: async () => "token" });

    await provider.transcribe({
      audio: new ArrayBuffer(4),
      mimeType: "audio/ogg",
      languageCode: "en-US",
    });

    const [, requestInit] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((requestInit as RequestInit).body as string);
    expect(body.config.sampleRateHertz).toBe(48000);
  });
});
