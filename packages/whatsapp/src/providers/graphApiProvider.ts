import type {
  MediaMetadata,
  SendAudioInput,
  SendResult,
  SendTextInput,
  WhatsAppProvider,
} from "../provider.js";

export interface GraphApiConfig {
  accessToken: string;
  graphApiVersion: string;
  /** Overridable for tests; defaults to the real Meta Graph API host. */
  baseUrl?: string;
}

/** Thrown for any non-2xx Graph API response, carrying enough detail to log without leaking the access token. */
export class WhatsAppProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorCode?: string,
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
      const errorCode = (body as { error?: { code?: string } })?.error?.code;
      throw new WhatsAppProviderError(
        `WhatsApp Graph API request to ${path} failed with status ${response.status}`,
        response.status,
        errorCode,
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
