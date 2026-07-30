export type ReplyModeSetting = "text_only" | "voice_only" | "text_and_voice" | "auto";
export type ResolvedReplyMode = "text_only" | "voice_only" | "text_and_voice";

export interface ReplyModeInput {
  incomingMessageType: "text" | "audio";
  companyDefaultReplyMode: ReplyModeSetting;
  /** Remembered per-contact preference (Master Prompt section 4); null if never set. */
  contactPreference: ReplyModeSetting | null;
  voiceEnabledForCompany: boolean;
  voiceEntitledByPlan: boolean;
  voiceUsageHeadroomAvailable: boolean;
  isSuspended: boolean;
  voiceProviderAvailable: boolean;
}

export interface ReplyModeResolution {
  mode: ResolvedReplyMode;
  downgraded: boolean;
  downgradeReason: string | null;
}

function resolveDesiredMode(input: ReplyModeInput): ResolvedReplyMode {
  const setting =
    input.contactPreference && input.contactPreference !== "auto"
      ? input.contactPreference
      : input.companyDefaultReplyMode;

  if (setting !== "auto") return setting;

  // Default behaviour (Master Prompt section 4): text in -> text reply; voice in -> text and voice reply.
  return input.incomingMessageType === "audio" ? "text_and_voice" : "text_only";
}

/**
 * Resolves the effective reply mode for a single outbound reply, applying the
 * precedence rules in Master Prompt section 4: contact preference overrides
 * company default UNLESS the company has disabled that mode, the plan doesn't
 * include it, a usage limit is reached, the account is suspended, or the voice
 * provider is unavailable -- in which case voice is downgraded to text_only.
 */
export function resolveReplyMode(input: ReplyModeInput): ReplyModeResolution {
  const desired = resolveDesiredMode(input);

  if (desired === "text_only") {
    return { mode: "text_only", downgraded: false, downgradeReason: null };
  }

  const blockReason = !input.voiceEnabledForCompany
    ? "voice_disabled_for_company"
    : !input.voiceEntitledByPlan
      ? "plan_missing_voice"
      : input.isSuspended
        ? "company_suspended"
        : !input.voiceUsageHeadroomAvailable
          ? "usage_limit_reached"
          : !input.voiceProviderAvailable
            ? "voice_provider_unavailable"
            : null;

  if (blockReason) {
    return { mode: "text_only", downgraded: true, downgradeReason: blockReason };
  }

  return { mode: desired, downgraded: false, downgradeReason: null };
}
