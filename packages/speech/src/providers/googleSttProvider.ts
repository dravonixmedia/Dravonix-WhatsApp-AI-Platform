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
          languageCode: input.languageCode,
          alternativeLanguageCodes: input.alternativeLanguageCodes ?? [],
          enableAutomaticPunctuation: true,
        },
        audio: { content: arrayBufferToBase64(input.audio) },
      }),
    });

    if (!response.ok) {
      throw new Error(`Google Speech-to-Text request failed with status ${response.status}`);
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
