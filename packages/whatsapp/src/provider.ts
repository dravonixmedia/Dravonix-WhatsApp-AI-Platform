export interface SendTextInput {
  phoneNumberId: string;
  toWaId: string;
  body: string;
}

export interface SendAudioInput {
  phoneNumberId: string;
  toWaId: string;
  /** A previously uploaded Meta media ID, or a publicly reachable HTTPS link. */
  audioMediaIdOrUrl: string;
}

export interface SendResult {
  providerMessageId: string;
}

export interface MediaMetadata {
  url: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

/**
 * Provider-agnostic WhatsApp send/media interface (Master Prompt section 10).
 * `GraphApiWhatsAppProvider` implements this against the real Meta Graph API;
 * `MockWhatsAppProvider` implements it for local development and tests without
 * a real WhatsApp Business Account.
 */
export interface WhatsAppProvider {
  sendText(input: SendTextInput): Promise<SendResult>;
  sendAudio(input: SendAudioInput): Promise<SendResult>;
  getMediaMetadata(mediaId: string): Promise<MediaMetadata>;
  downloadMedia(url: string): Promise<ArrayBuffer>;
  uploadMedia(
    phoneNumberId: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ): Promise<{ mediaId: string }>;
}
