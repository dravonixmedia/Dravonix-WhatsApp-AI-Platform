import type {
  MediaMetadata,
  SendAudioInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
  WhatsAppProvider,
} from "../provider.js";

export interface GraphApiConfig {
  accessToken: string;
  graphApiVersion: string;
  /** Overridable for tests; defaults to the real Meta Graph API host. */
  baseUrl?: string;
}

/**
 * Thrown for any non-2xx Graph API response, carrying enough detail to log
 * without leaking the access token. `errorSubcode` (Meta's `error_subcode`,
 * e.g. the family of codes Meta uses for an outside-service-window
 * rejection) is captured alongside `errorCode` purely for structured
 * observability -- see classifySendError's doc comment (Meta/WhatsApp Batch
 * 2, Phase 9): neither field is ever matched against a fragile English
 * error string to decide behavior.
 */
export class WhatsAppProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorCode?: string,
    public readonly errorSubcode?: string,
  ) {
    super(message);
    this.name = "WhatsAppProviderError";
  }
}

/**
 * Real Meta WhatsApp Cloud API adapter. Used whenever `env.whatsappConfigured`
 * is true (packages/config). Never logs `accessToken`.
 */
export class GraphApiWhatsAppProvider implements WhatsAppProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: GraphApiConfig) {
    this.baseUrl = config.baseUrl ?? `https://graph.facebook.com/${config.graphApiVersion}`;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const apiError = (
        body as { error?: { code?: string | number; error_subcode?: string | number } }
      )?.error;
      throw new WhatsAppProviderError(
        `WhatsApp Graph API request to ${path} failed with status ${response.status}`,
        response.status,
        apiError?.code !== undefined ? String(apiError.code) : undefined,
        apiError?.error_subcode !== undefined ? String(apiError.error_subcode) : undefined,
      );
    }

    return response.json();
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    const data = (await this.request(`/${input.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: input.toWaId,
        type: "text",
        text: { body: input.body },
      }),
    })) as { messages: Array<{ id: string }> };

    const message = data.messages[0];
    if (!message) {
      throw new WhatsAppProviderError("WhatsApp send response had no message ID", 502);
    }
    return { providerMessageId: message.id };
  }

  async sendAudio(input: SendAudioInput): Promise<SendResult> {
    const isUrl = input.audioMediaIdOrUrl.startsWith("http");
    const data = (await this.request(`/${input.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: input.toWaId,
        type: "audio",
        audio: isUrl ? { link: input.audioMediaIdOrUrl } : { id: input.audioMediaIdOrUrl },
      }),
    })) as { messages: Array<{ id: string }> };

    const message = data.messages[0];
    if (!message) {
      throw new WhatsAppProviderError("WhatsApp send response had no message ID", 502);
    }
    return { providerMessageId: message.id };
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const data = (await this.request(`/${input.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: input.toWaId,
        type: "template",
        template: {
          name: input.templateName,
          language: { code: input.languageCode },
          ...(input.bodyParameters.length > 0
            ? {
                components: [
                  {
                    type: "body",
                    parameters: input.bodyParameters.map((text) => ({ type: "text", text })),
                  },
                ],
              }
            : {}),
        },
      }),
    })) as { messages: Array<{ id: string }> };

    const message = data.messages[0];
    if (!message) {
      throw new WhatsAppProviderError("WhatsApp send response had no message ID", 502);
    }
    return { providerMessageId: message.id };
  }

  async getMediaMetadata(mediaId: string): Promise<MediaMetadata> {
    const data = (await this.request(`/${mediaId}`, { method: "GET" })) as {
      url: string;
      mime_type?: string;
      file_size?: number;
    };
    return { url: data.url, mimeType: data.mime_type ?? null, sizeBytes: data.file_size ?? null };
  }

  async downloadMedia(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
    });
    if (!response.ok) {
      throw new WhatsAppProviderError(`Failed to download media from ${url}`, response.status);
    }
    return response.arrayBuffer();
  }

  async uploadMedia(
    phoneNumberId: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ): Promise<{ mediaId: string }> {
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("file", new Blob([bytes], { type: mimeType }));
    const data = (await this.request(`/${phoneNumberId}/media`, {
      method: "POST",
      body: form,
    })) as { id: string };
    return { mediaId: data.id };
  }
}
