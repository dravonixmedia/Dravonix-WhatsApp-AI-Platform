import type { SpeechToTextInput, SpeechToTextProvider, SpeechToTextResult } from "../provider.js";

export interface GoogleSttConfig {
  getAccessToken: () => Promise<string>;
  /** Overridable for tests; defaults to the real Google Speech-to-Text REST endpoint. */
  baseUrl?: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const OPUS_HEAD_MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"

/**
 * Reads the "input sample rate" field straight out of the Ogg Opus ID header
 * (RFC 7845 section 5.1). Google's STT API requires an explicit sampleRateHertz
 * for OGG_OPUS and rejects requests without one ("Opus sample rate (0) not in
 * supported rates"), but the value it actually needs varies by encoder --
 * WhatsApp's own voice notes have been observed declaring 24000 Hz, not the
 * commonly-assumed 16000 or 48000, so hardcoding any single constant here
 * silently produces empty transcripts for files where the guess is wrong.
 * Falls back to 48000 (Opus's native internal rate) if the header can't be found.
 */
function readOggOpusInputSampleRate(audio: ArrayBuffer): number {
  const bytes = new Uint8Array(audio);
  // Sample rate is read at i+12 for 4 bytes, so i+16 must stay in bounds.
  for (let i = 0; i <= bytes.length - 16; i += 1) {
    let matches = true;
    for (let j = 0; j < OPUS_HEAD_MAGIC.length; j += 1) {
      if (bytes[i + j] !== OPUS_HEAD_MAGIC[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      // Layout after the magic: version(1) + channels(1) + pre-skip(2) + sample rate(4, LE).
      return new DataView(audio, i + 12, 4).getUint32(0, true);
    }
  }
  return 48000;
}

/**
 * Google Cloud Speech-to-Text v1 REST adapter. Sends the primary language code
 * plus alternative language hints for mixed-language speech (Master Prompt
 * section 5), and surfaces the detected language + confidence for storage and
 * human correction.
 */
export class GoogleSpeechToTextProvider implements SpeechToTextProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: GoogleSttConfig) {
    this.baseUrl = config.baseUrl ?? "https://speech.googleapis.com/v1/speech:recognize";
  }

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    const accessToken = await this.config.getAccessToken();

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config: {
          encoding: "OGG_OPUS",
          sampleRateHertz: readOggOpusInputSampleRate(input.audio),
          languageCode: input.languageCode,
          alternativeLanguageCodes: input.alternativeLanguageCodes ?? [],
          enableAutomaticPunctuation: true,
        },
        audio: { content: arrayBufferToBase64(input.audio) },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Google Speech-to-Text request failed with status ${response.status}: ${body}`,
      );
    }

    const data = (await response.json()) as {
      results?: Array<{
        alternatives: Array<{ transcript: string; confidence?: number }>;
        languageCode?: string;
      }>;
    };

    const firstResult = data.results?.[0];
    const firstAlternative = firstResult?.alternatives[0];

    return {
      text: firstAlternative?.transcript ?? "",
      detectedLanguageCode: firstResult?.languageCode ?? null,
      confidence: firstAlternative?.confidence ?? null,
    };
  }
}
