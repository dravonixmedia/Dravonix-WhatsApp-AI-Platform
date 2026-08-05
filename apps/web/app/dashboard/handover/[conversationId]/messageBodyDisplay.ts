import type { ConversationThreadMessage } from "@dravonix/handover";

/**
 * Resolves what ConversationThread should render in place of a message's raw
 * body. Diagnosed from a staging incident: an inbound audio message with a
 * null body (transcript not yet recorded, or never recorded due to a
 * separate bug) rendered as a completely empty card -- `{message.body}` with
 * body === null renders nothing, leaving no indication of why. This always
 * returns a non-empty, honest string: a real transcript/text body when
 * present, otherwise an explicit placeholder that doesn't claim a specific
 * processing/failure state we have no data to back (this query doesn't join
 * media_files/transcription status), only that content isn't available yet.
 */
export function resolveMessageBodyDisplay(message: ConversationThreadMessage): string {
  if (message.body && message.body.trim().length > 0) {
    return message.body;
  }
  if (message.channelType === "audio") {
    return message.direction === "inbound"
      ? "Voice message received -- transcript not available yet."
      : "Voice reply sent -- no text transcript recorded.";
  }
  return "(no message content)";
}
