import type { TextToSpeechInput, TextToSpeechProvider, TextToSpeechResult } from "../provider.js";

export interface GoogleTtsConfig {
  getAccessToken: () => Promise<string>;
  defaultVoice: string;
  baseUrl?: string;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Google Cloud Text-to-Speech v1 REST adapter. Requests OGG/Opus output
 * directly (ADR-0005) so replies can be sent to WhatsApp without a separate
 * transcoding step.
 */
export class GoogleTextToSpeechProvider implements TextToSpeechProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: GoogleTtsConfig) {
    this.baseUrl = config.baseUrl ?? "https://texttospeech.googleapis.com/v1/text:synthesize";
  }

  async synthesize(input: TextToSpeechInput): Promise<TextToSpeechResult> {
    const accessToken = await this.config.getAccessToken();

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: { text: input.text },
        voice: {
          languageCode: input.languageCode,
          name: input.voiceId ?? this.config.defaultVoice,
        },
        audioConfig: {
          audioEncoding: "OGG_OPUS",
          speakingRate: input.speakingRate ?? 1.0,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Google Text-to-Speech request failed with status ${response.status}: ${body}`,
      );
    }

    const data = (await response.json()) as { audioContent: string };
    return { audio: base64ToArrayBuffer(data.audioContent), mimeType: "audio/ogg" };
  }
}
