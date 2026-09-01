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

/**
 * Sends a pre-approved WhatsApp message template (Meta/WhatsApp Batch 2) --
 * the only message type Meta allows once the 24-hour customer service
 * window has closed. `templateName`/`languageCode` must already be an
 * approved template on Meta's side; this call never submits anything for
 * approval. `bodyParameters` fills the template's positional {{1}}, {{2}},
 * ... body placeholders in order -- empty for a fixed-text template with no
 * variables, which is what this batch's service-window fallback template is
 * expected to be (see whatsapp_accounts.service_window_fallback_template_id's
 * column comment, migration 36).
 */
export interface SendTemplateInput {
  phoneNumberId: string;
  toWaId: string;
  templateName: string;
  languageCode: string;
  bodyParameters: string[];
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
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
  getMediaMetadata(mediaId: string): Promise<MediaMetadata>;
  downloadMedia(url: string): Promise<ArrayBuffer>;
  uploadMedia(
    phoneNumberId: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ): Promise<{ mediaId: string }>;
}
