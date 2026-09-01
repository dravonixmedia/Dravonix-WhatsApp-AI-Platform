import type {
  MediaMetadata,
  SendAudioInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
  WhatsAppProvider,
} from "../provider.js";

/**
 * In-memory WhatsApp provider used for local development (no Meta credentials
 * configured) and tests. Records every "sent" message so tests can assert on
 * what would have been sent, without any network call.
 */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly sentText: SendTextInput[] = [];
  readonly sentAudio: SendAudioInput[] = [];
  readonly sentTemplate: SendTemplateInput[] = [];
  private counter = 0;

  private nextId(prefix: string): string {
    this.counter += 1;
    return `wamid.MOCK.${prefix}.${this.counter}`;
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    this.sentText.push(input);
    return { providerMessageId: this.nextId("text") };
  }

  async sendAudio(input: SendAudioInput): Promise<SendResult> {
    this.sentAudio.push(input);
    return { providerMessageId: this.nextId("audio") };
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    this.sentTemplate.push(input);
    return { providerMessageId: this.nextId("template") };
  }

  async getMediaMetadata(mediaId: string): Promise<MediaMetadata> {
    return { url: `https://mock.local/media/${mediaId}`, mimeType: "audio/ogg", sizeBytes: 1024 };
  }

  async downloadMedia(_url: string): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  async uploadMedia(
    _phoneNumberId: string,
    _bytes: ArrayBuffer,
    _mimeType: string,
  ): Promise<{ mediaId: string }> {
    return { mediaId: this.nextId("media") };
  }
}
