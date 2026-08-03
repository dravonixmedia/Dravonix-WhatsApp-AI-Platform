import { isMalayalamLanguageCode } from "../malayalamDetection.js";
import type { TextToSpeechInput, TextToSpeechProvider, TextToSpeechResult } from "../provider.js";

export interface ElevenLabsTtsConfig {
  apiKey: string;
  defaultVoiceId: string;
  /** ElevenLabs TTS model, e.g. "eleven_multilingual_v2". Used for non-Malayalam replies. */
  modelId: string;
  /** Dedicated Malayalam voice (e.g. an Instant Voice Clone of a native Kerala speaker). Optional -- falls back to defaultVoiceId when unset. */
  malayalamVoiceId?: string;
  /** Optional explicit English voice; falls back to defaultVoiceId when unset. */
  englishVoiceId?: string;
  /** Model used for Malayalam replies, e.g. "eleven_v3". Falls back to modelId when unset. */
  malayalamModelId?: string;
  /** Overridable for tests; defaults to the real ElevenLabs text-to-speech endpoint. */
  baseUrl?: string;
}

/**
 * Fixed, tuned Eleven v3 voice settings for Malayalam only -- "Natural"
 * stability plus values that keep pronunciation consistent instead of
 * flipping style mid-sentence across Malayalam/English-script boundaries.
 * Never applied to English requests (`speed` there still comes from
 * input.speakingRate, unchanged).
 */
const MALAYALAM_VOICE_SETTINGS = {
  stability: "natural",
  speed: 0.92,
  similarity_boost: 0.8,
  style: 0,
  use_speaker_boost: true,
} as const;

/**
 * ElevenLabs text-to-speech adapter. Requests Opus output directly (ADR-0005)
 * so replies can be sent to WhatsApp without a separate transcoding step.
 *
 * `language_code` is a documented ElevenLabs request-body parameter (ISO
 * 639-1) supported by eleven_v3 to enforce a language for the model and text
 * normalization; it is not supported by eleven_multilingual_v2, so it is only
 * sent for Malayalam requests, which always use the Malayalam-specific model.
 */
export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: ElevenLabsTtsConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io/v1/text-to-speech";
  }

  async synthesize(input: TextToSpeechInput): Promise<TextToSpeechResult> {
    const isMalayalam = isMalayalamLanguageCode(input.languageCode);

    const voiceId =
      input.voiceId ??
      (isMalayalam ? this.config.malayalamVoiceId : this.config.englishVoiceId) ??
      this.config.defaultVoiceId;
    const modelId = isMalayalam
      ? (this.config.malayalamModelId ?? this.config.modelId)
      : this.config.modelId;
    const fallbackVoiceUsed = isMalayalam && !input.voiceId && !this.config.malayalamVoiceId;

    const url = `${this.baseUrl}/${voiceId}?output_format=opus_48000_128`;

    const voiceSettings = isMalayalam
      ? MALAYALAM_VOICE_SETTINGS
      : input.speakingRate
        ? { speed: input.speakingRate }
        : undefined;

    const body: Record<string, unknown> = {
      text: input.text,
      model_id: modelId,
      voice_settings: voiceSettings,
    };
    if (isMalayalam) {
      body.language_code = "ml";
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new Error(
        `ElevenLabs text-to-speech request failed with status ${response.status}: ${responseBody}`,
      );
    }

    const audio = await response.arrayBuffer();
    return {
      audio,
      mimeType: "audio/ogg",
      voiceCategory: isMalayalam ? "malayalam" : "default",
      modelId,
      fallbackVoiceUsed,
    };
  }
}
