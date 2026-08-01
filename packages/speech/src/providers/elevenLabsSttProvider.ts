import type { SpeechToTextInput, SpeechToTextProvider, SpeechToTextResult } from "../provider.js";

export interface ElevenLabsSttConfig {
  apiKey: string;
  /** ElevenLabs STT model, e.g. "scribe_v1". */
  modelId: string;
  /** Overridable for tests; defaults to the real ElevenLabs speech-to-text endpoint. */
  baseUrl?: string;
}

/**
 * ElevenLabs Scribe speech-to-text adapter. Accepts Ogg/Opus directly (no
 * sample rate to declare, unlike Google's STT API) and auto-detects the
 * spoken language itself, so no language hint is sent -- forcing one based on
 * the company's configured primary language would hurt accuracy whenever a
 * customer speaks a different one of their enabled languages.
 */
export class ElevenLabsSpeechToTextProvider implements SpeechToTextProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: ElevenLabsSttConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io/v1/speech-to-text";
  }

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    const formData = new FormData();
    formData.append("file", new Blob([input.audio], { type: input.mimeType }), "voice-note.ogg");
    formData.append("model_id", this.config.modelId);

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "xi-api-key": this.config.apiKey },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `ElevenLabs speech-to-text request failed with status ${response.status}: ${body}`,
      );
    }

    const data = (await response.json()) as {
      text?: string;
      language_code?: string;
      language_probability?: number;
    };

    return {
      text: data.text?.trim() ?? "",
      detectedLanguageCode: data.language_code ?? null,
      confidence: data.language_probability ?? null,
    };
  }
}
