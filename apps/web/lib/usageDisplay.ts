/**
 * Truthful grouping/display for the Admin Usage page (P0 usage-repair
 * independent review, Correction 2). speech_to_text_seconds and
 * generated_voice_seconds are DURATION metrics; text_to_speech_characters is
 * a CHARACTER-COUNT metric with a structurally different unit -- they must
 * never be summed together or displayed under a single "voice seconds"
 * label, and an absent duration metric must never be presented as a
 * verified zero.
 */

export const MESSAGE_METRICS = new Set([
  "whatsapp_inbound_messages",
  "whatsapp_outbound_messages",
  "whatsapp_template_messages",
]);

export const VOICE_DURATION_METRICS = new Set([
  "speech_to_text_seconds",
  "generated_voice_seconds",
]);

export const TTS_CHARACTER_METRIC = "text_to_speech_characters";

export interface CompanyUsage {
  companyId: string;
  companyName: string;
  messages: number;
  voiceDurationSeconds: number;
  /** True once at least one voice-duration usage_summaries row has been observed for this company -- distinguishes "measured zero" from "never metered." */
  voiceDurationMetered: boolean;
  ttsCharacters: number;
  /** True once at least one text_to_speech_characters usage_summaries row has been observed for this company. */
  ttsMetered: boolean;
}

export interface UsageSummaryRow {
  companyId: string;
  companyName: string | null;
  metric: string;
  totalQuantity: number | null;
}

function newCompanyUsage(companyId: string, companyName: string): CompanyUsage {
  return {
    companyId,
    companyName,
    messages: 0,
    voiceDurationSeconds: 0,
    voiceDurationMetered: false,
    ttsCharacters: 0,
    ttsMetered: false,
  };
}

/** Folds one usage_summaries row into the running per-company totals, mutating and returning the map. */
export function accumulateCompanyUsage(
  byCompany: Map<string, CompanyUsage>,
  row: UsageSummaryRow,
): Map<string, CompanyUsage> {
  const existing =
    byCompany.get(row.companyId) ??
    newCompanyUsage(row.companyId, row.companyName ?? "Unknown company");
  const quantity = Number(row.totalQuantity ?? 0);

  if (MESSAGE_METRICS.has(row.metric)) {
    existing.messages += quantity;
  } else if (VOICE_DURATION_METRICS.has(row.metric)) {
    existing.voiceDurationSeconds += quantity;
    existing.voiceDurationMetered = true;
  } else if (row.metric === TTS_CHARACTER_METRIC) {
    existing.ttsCharacters += quantity;
    existing.ttsMetered = true;
  }

  byCompany.set(row.companyId, existing);
  return byCompany;
}

/** Per-company voice-duration label -- never implies a verified zero when no duration source has ever recorded usage. */
export function formatVoiceDuration(
  usage: Pick<CompanyUsage, "voiceDurationMetered" | "voiceDurationSeconds">,
): string {
  return usage.voiceDurationMetered
    ? `${usage.voiceDurationSeconds}s voice`
    : "Voice duration not metered";
}

/**
 * Per-company TTS-character label -- always presented as characters, never
 * added to a duration quantity. Unlike voice duration, this metric is
 * genuinely instrumented (Correction 1), so an unmetered company has simply
 * never generated TTS output -- a real zero, not an absent measurement.
 */
export function formatTtsCharacters(usage: Pick<CompanyUsage, "ttsCharacters">): string {
  return `${usage.ttsCharacters} TTS characters`;
}
