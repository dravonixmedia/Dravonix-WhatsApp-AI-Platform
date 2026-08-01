import type { TextToSpeechInput, TextToSpeechProvider, TextToSpeechResult } from "../provider.js";

export interface ElevenLabsTtsConfig {
  apiKey: string;
  defaultVoiceId: string;
  /** ElevenLabs TTS model, e.g. "eleven_multilingual_v2". */
  modelId: string;
  /** Overridable for tests; defaults to the real ElevenLabs text-to-speech endpoint. */
  baseUrl?: string;
}

/**
 * ElevenLabs text-to-speech adapter. Requests Opus output directly (ADR-0005)
 * so replies can be sent to WhatsApp without a separate transcoding step.
 *
 * Note: `output_format=opus_48000_128` and `voice_settings.speed` are based on
 * ElevenLabs' documented API surface at implementation time -- verify both
 * against a live account before relying on this in production, since neither
 * has been exercised against a real API key/response in this environment.
 */
export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: ElevenLabsTtsConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io/v1/text-to-speech";
  }

  async synthesize(input: TextToSpeechInput): Promise<TextToSpeechResult> {
    const voiceId = input.voiceId ?? this.config.defaultVoiceId;
    const url = `${this.baseUrl}/${voiceId}?output_format=opus_48000_128`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: input.text,
        model_id: this.config.modelId,
        // ElevenLabs infers language from the text itself with multilingual
        // models -- there is no separate languageCode parameter to set.
        voice_settings: input.speakingRate ? { speed: input.speakingRate } : undefined,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `ElevenLabs text-to-speech request failed with status ${response.status}: ${body}`,
      );
    }

    const audio = await response.arrayBuffer();
    return { audio, mimeType: "audio/ogg" };
  }
}
