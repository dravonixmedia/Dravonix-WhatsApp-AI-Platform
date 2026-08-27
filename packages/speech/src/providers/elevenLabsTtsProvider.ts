import type { TextToSpeechInput, TextToSpeechProvider, TextToSpeechResult } from "../provider.js";
import { elevenLabsErrorFromStatus, elevenLabsNetworkError } from "./elevenLabsError.js";

export interface ElevenLabsTtsConfig {
  apiKey: string;
  defaultVoiceId: string;
  /** ElevenLabs TTS model used for non-Malayalam replies, e.g. "eleven_multilingual_v2". */
  modelId: string;
  /**
   * Dedicated voice for Malayalam (and Malayalam-dominant mixed) replies --
   * ideally a Malayalam Instant Voice Clone recorded by a native Kerala
   * speaker (final plan section 4), configured via ELEVENLABS_MALAYALAM_VOICE_ID.
   * Never hardcoded; falls back to defaultVoiceId when unset.
   */
  malayalamVoiceId?: string;
  /** Voice for English replies, configured via ELEVENLABS_ENGLISH_VOICE_ID. Falls back to defaultVoiceId when unset. */
  englishVoiceId?: string;
  /** TTS model used specifically for Malayalam, e.g. "eleven_v3" (ELEVENLABS_MALAYALAM_MODEL_ID). Falls back to modelId when unset. */
  malayalamModelId?: string;
  /** Optional ElevenLabs pronunciation dictionary, applied only to Malayalam requests when both id and version are configured. */
  pronunciationDictionaryId?: string;
  pronunciationDictionaryVersionId?: string;
  /** Overridable for tests; defaults to the real ElevenLabs text-to-speech endpoint. */
  baseUrl?: string;
}

function isMalayalamLanguageCode(languageCode: string): boolean {
  return languageCode.trim().toLowerCase().startsWith("ml");
}

/**
 * ElevenLabs text-to-speech adapter. Requests Opus output directly (ADR-0005)
 * so replies can be sent to WhatsApp without a separate transcoding step.
 *
 * Malayalam gets its own voice, model (eleven_v3), and stability preset --
 * `input.languageCode` (set by the caller from the AI reply's actual
 * dominant script, not just a language tag) decides which of the two
 * configured voices/models is used. An explicit per-call `voiceId` (e.g. a
 * company's own per-language override) always takes priority over both.
 *
 * Note: `output_format=opus_48000_128`, `voice_settings.speed`,
 * `language_code`, the `stability: "natural"` preset, and the pronunciation
 * dictionary locator shape are based on ElevenLabs' documented API surface
 * at implementation time -- verify all of these against a live account
 * before relying on this in production, since none has been exercised
 * against a real API key/response in this environment.
 */
export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  readonly providerName = "elevenlabs";
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

    const url = `${this.baseUrl}/${voiceId}?output_format=opus_48000_128`;

    const voiceSettings: Record<string, unknown> = {};
    if (input.speakingRate) voiceSettings.speed = input.speakingRate;
    // Eleven v3's stability parameter accepts named presets instead of a
    // numeric slider -- "natural" is the closest to unscripted, conversational
    // spoken delivery, which is what final plan's Malayalam style calls for.
    if (isMalayalam) voiceSettings.stability = "natural";

    const body: Record<string, unknown> = {
      text: input.text,
      model_id: modelId,
      voice_settings: Object.keys(voiceSettings).length > 0 ? voiceSettings : undefined,
    };

    if (isMalayalam) {
      body.language_code = "ml";
      if (this.config.pronunciationDictionaryId && this.config.pronunciationDictionaryVersionId) {
        body.pronunciation_dictionary_locators = [
          {
            pronunciation_dictionary_id: this.config.pronunciationDictionaryId,
            version_id: this.config.pronunciationDictionaryVersionId,
          },
        ];
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw elevenLabsNetworkError("text-to-speech", error);
    }

    if (!response.ok) {
      // The raw response body is deliberately never read here -- see the
      // identical note in elevenLabsSttProvider.ts.
      throw elevenLabsErrorFromStatus("text-to-speech", response.status);
    }

    const audio = await response.arrayBuffer();
    return { audio, mimeType: "audio/ogg" };
  }
}
