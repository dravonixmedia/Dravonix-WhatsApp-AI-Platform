import type { JobEnvelope } from "@dravonix/core";

/** Payload for apps/workers/message-consumer -- a single inbound text message to process. */
export interface MessageJobPayload extends JobEnvelope {
  kind: "inbound_text";
  conversationId: string;
  messageId: string;
  waId: string;
  body: string;
}

/** Payload for apps/workers/voice-consumer -- a single inbound voice note to process. */
export interface VoiceJobPayload extends JobEnvelope {
  kind: "inbound_audio";
  conversationId: string;
  messageId: string;
  waId: string;
  mediaId: string;
  mimeType: string | null;
}
