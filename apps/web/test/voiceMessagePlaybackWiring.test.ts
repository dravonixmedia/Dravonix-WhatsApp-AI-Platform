import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for voice playback in the shared conversation
 * thread (P1 dashboard hygiene batch). ConversationThread.tsx is a "use
 * client" component with hooks/realtime subscriptions and no
 * @testing-library/react harness in this repo (see navItems.test.ts's
 * identical note) -- covered by reading the source, the same convention
 * used throughout apps/web/test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const threadDir = join(webRoot, "app/dashboard/handover/[conversationId]");
const threadSource = readFileSync(join(threadDir, "ConversationThread.tsx"), "utf8");
const playerSource = readFileSync(join(threadDir, "VoiceMessagePlayer.tsx"), "utf8");

describe("VoiceMessagePlayer renders native, accessible, non-autoplaying audio", () => {
  it("renders a native <audio> element with controls, never a custom player", () => {
    expect(playerSource).toContain("<audio");
    expect(playerSource).toContain("controls");
  });

  it("never autoplays and never eagerly preloads the full file", () => {
    expect(playerSource).not.toMatch(/\bautoPlay\b/);
    expect(playerSource).not.toContain("autoPlay={true}");
    expect(playerSource).toContain('preload="none"');
  });

  it("points src at the authenticated, company-scoped media route -- never a raw storage URL", () => {
    expect(playerSource).toMatch(/src=\{`\/api\/media\/audio\/\$\{mediaFileId\}`\}/);
    expect(playerSource).not.toMatch(/r2\.cloudflarestorage\.com|storage_key|storageKey/);
  });

  it("gives the player a meaningful accessible label", () => {
    expect(playerSource).toContain("aria-label={label}");
  });
});

describe("ConversationThread renders the voice player only when playable audio exists", () => {
  it("imports VoiceMessagePlayer and renders it conditionally on message.mediaFileId", () => {
    expect(threadSource).toContain('import { VoiceMessagePlayer } from "./VoiceMessagePlayer.js"');
    const conditional = threadSource.match(
      /\{message\.mediaFileId \? \(\s*<VoiceMessagePlayer[\s\S]*?\/>\s*\) : null\}/,
    );
    expect(conditional).not.toBeNull();
  });

  it("passes the real mediaFileId and duration through, not a placeholder", () => {
    const conditional = threadSource.match(
      /\{message\.mediaFileId \? \(\s*<VoiceMessagePlayer[\s\S]*?\/>\s*\) : null\}/,
    )?.[0];
    expect(conditional).toContain("mediaFileId={message.mediaFileId}");
    expect(conditional).toContain("durationSeconds={message.mediaDurationSeconds}");
  });

  it("still renders the existing text/placeholder body alongside the player -- text-only messages are completely unaffected (mediaFileId is always null for them)", () => {
    expect(threadSource).toContain("resolveMessageBodyDisplay(message)");
  });

  it("keeps the existing audio-channel mic-icon indicator in the message header, unchanged", () => {
    expect(threadSource).toContain(
      'message.channelType === "audio" ? <MicIcon size={11} /> : null',
    );
  });
});

describe("Realtime messages never fabricate media metadata they cannot know", () => {
  it("mapRealtimeMessageRow sets all three media fields to null -- a realtime INSERT payload has no media_files join", () => {
    const source = readFileSync(join(threadDir, "realtimeMessageMapper.ts"), "utf8");
    expect(source).toContain("mediaFileId: null");
    expect(source).toContain("mediaMimeType: null");
    expect(source).toContain("mediaDurationSeconds: null");
  });
});

describe("The server-side thread query embeds media_files so voice playback works without a second per-message query", () => {
  it("supabaseHandoverRepository selects the media_files embed and excludes retention-deleted rows", () => {
    const source = readFileSync(
      join(webRoot, "..", "..", "packages/handover/src/repositories/supabaseHandoverRepository.ts"),
      "utf8",
    );
    expect(source).toContain("media_files (id, mime_type, duration_seconds, deleted_at)");
    expect(source).toContain("embedded && !embedded.deleted_at ? embedded : null");
  });
});
