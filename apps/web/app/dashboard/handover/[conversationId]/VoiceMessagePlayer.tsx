/**
 * Native, accessible audio playback for a voice message (P1 dashboard
 * hygiene batch). Deliberately plain <audio controls> rather than a custom
 * player: native controls already give play/pause, seek, and keyboard
 * support for free, and this repo has no existing custom-slider design
 * pattern to match. `src` points at the authenticated, company-scoped
 * /api/media/audio route -- never a direct storage URL.
 */
export function VoiceMessagePlayer({
  mediaFileId,
  durationSeconds,
}: {
  mediaFileId: string;
  durationSeconds: number | null;
}) {
  const label =
    durationSeconds != null
      ? `Voice message, ${Math.round(durationSeconds)} seconds`
      : "Voice message";

  return (
    <audio
      controls
      preload="none"
      src={`/api/media/audio/${mediaFileId}`}
      aria-label={label}
      style={{ display: "block", maxWidth: "100%", marginTop: "0.4rem", height: "32px" }}
    >
      Your browser does not support audio playback.
    </audio>
  );
}
