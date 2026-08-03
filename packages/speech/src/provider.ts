export interface SpeechToTextInput {
  audio: ArrayBuffer;
  mimeType: string;
  /** Primary language hint, e.g. "ml-IN". Sourced from the company's enabled languages. */
  languageCode: string;
  /** Additional hints for mixed-language speech (Master Prompt section 5: Malayalam-English mixed). */
  alternativeLanguageCodes?: string[];
}

export interface SpeechToTextResult {
  text: string;
  detectedLanguageCode: string | null;
  confidence: number | null;
}

export interface SpeechToTextProvider {
  /** Stable identifier for whichever vendor this implementation calls (e.g. "elevenlabs", "whisper", "google"), recorded alongside each transcription so the audit trail can never drift out of sync with which provider actually produced it. */
  readonly providerName: string;
  transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult>;
}

export interface TextToSpeechInput {
  text: string;
  languageCode: string;
  voiceId?: string;
  speakingRate?: number;
}

export interface TextToSpeechResult {
  audio: ArrayBuffer;
  mimeType: string;
  /** Sanitized voice-selection signal for logging -- never the actual voice ID. */
  voiceCategory?: "malayalam" | "default";
  modelId?: string;
  /** True when a Malayalam reply had to use the default voice because no Malayalam voice ID was configured. */
  fallbackVoiceUsed?: boolean;
}

export interface TextToSpeechProvider {
  synthesize(input: TextToSpeechInput): Promise<TextToSpeechResult>;
}
