import { EntitlementDeniedError } from "@dravonix/core";
import { describe, expect, it, vi } from "vitest";
import {
  assertCompanyMayUseProvider,
  type EntitlementRepository,
  type EntitlementSnapshot,
} from "../src/entitlementGuard.js";

const COMPANY_ID = "aaaaaaaa-0000-0000-0000-000000000001";

function repoWith(snapshot: EntitlementSnapshot): EntitlementRepository {
  return { getSnapshot: vi.fn(async () => snapshot) };
}

const activeSnapshot: EntitlementSnapshot = {
  companyStatus: "active",
  subscriptionState: "active",
  features: {
    voice_enabled: { isEnabled: true, numericLimit: null },
    document_knowledge_base: { isEnabled: true, numericLimit: null },
  },
  usage: { monthly_messages: 10, monthly_voice_minutes: 5 },
};

describe("assertCompanyMayUseProvider", () => {
  it("allows a fully-entitled active company to use every capability", async () => {
    const repo = repoWith(activeSnapshot);
    await expect(
      assertCompanyMayUseProvider(repo, COMPANY_ID, "claude_response"),
    ).resolves.toBeUndefined();
    await expect(
      assertCompanyMayUseProvider(repo, COMPANY_ID, "speech_to_text"),
    ).resolves.toBeUndefined();
    await expect(
      assertCompanyMayUseProvider(repo, COMPANY_ID, "text_to_speech"),
    ).resolves.toBeUndefined();
    await expect(
      assertCompanyMayUseProvider(repo, COMPANY_ID, "whatsapp_send"),
    ).resolves.toBeUndefined();
    await expect(
      assertCompanyMayUseProvider(repo, COMPANY_ID, "knowledge_ingestion"),
    ).resolves.toBeUndefined();
  });

  it("denies every capability for a manually suspended company", async () => {
    const repo = repoWith({ ...activeSnapshot, companyStatus: "manually_suspended" });
    const error = await assertCompanyMayUseProvider(repo, COMPANY_ID, "claude_response").catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(EntitlementDeniedError);
    expect((error as EntitlementDeniedError).reason).toBe("company_manually_suspended");
  });

  it("denies every capability for a company whose subscription is suspended", async () => {
    const repo = repoWith({ ...activeSnapshot, subscriptionState: "suspended" });
    const error = await assertCompanyMayUseProvider(repo, COMPANY_ID, "text_to_speech").catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(EntitlementDeniedError);
    expect((error as EntitlementDeniedError).reason).toBe("subscription_not_active");
  });

  it("still allows service during grace_period (Master Prompt section 22)", async () => {
    const repo = repoWith({ ...activeSnapshot, subscriptionState: "grace_period" });
    await expect(
      assertCompanyMayUseProvider(repo, COMPANY_ID, "claude_response"),
    ).resolves.toBeUndefined();
  });

  it("denies voice capabilities when the plan does not include voice", async () => {
    const repo = repoWith({
      ...activeSnapshot,
      features: {
        ...activeSnapshot.features,
        voice_enabled: { isEnabled: false, numericLimit: null },
      },
    });
    const error = await assertCompanyMayUseProvider(repo, COMPANY_ID, "speech_to_text").catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(EntitlementDeniedError);
    expect((error as EntitlementDeniedError).reason).toBe("plan_missing_feature");
  });

  it("denies Claude usage once the monthly message limit is reached", async () => {
    const repo = repoWith({
      ...activeSnapshot,
      features: {
        ...activeSnapshot.features,
        monthly_messages: { isEnabled: true, numericLimit: 10 },
      },
      usage: { monthly_messages: 10 },
    });
    const error = await assertCompanyMayUseProvider(repo, COMPANY_ID, "claude_response").catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(EntitlementDeniedError);
    expect((error as EntitlementDeniedError).reason).toBe("usage_limit_reached");
  });

  it("allows unlimited usage when numericLimit is null", async () => {
    const repo = repoWith({
      ...activeSnapshot,
      usage: { monthly_messages: 1_000_000 },
    });
    await expect(
      assertCompanyMayUseProvider(repo, COMPANY_ID, "claude_response"),
    ).resolves.toBeUndefined();
  });
});

/**
 * The critical Master Prompt acceptance-criteria proof: a suspended company must
 * cause zero calls to any paid provider (Claude, STT, TTS, WhatsApp send). This
 * simulates the shape of apps/workers/message-consumer and voice-consumer: each
 * provider call is preceded by assertCompanyMayUseProvider, and we assert the
 * mock providers underneath are never invoked when that guard throws.
 */
describe("suspended company triggers zero provider calls (acceptance criteria #22)", () => {
  it("never calls Claude, STT, TTS, or the WhatsApp sender for a suspended company", async () => {
    const repo = repoWith({ ...activeSnapshot, companyStatus: "suspended" });

    const claudeGenerate = vi.fn();
    const sttTranscribe = vi.fn();
    const ttsSynthesize = vi.fn();
    const whatsappSend = vi.fn();

    async function processInboundVoiceMessage() {
      await assertCompanyMayUseProvider(repo, COMPANY_ID, "speech_to_text");
      await sttTranscribe();
      await assertCompanyMayUseProvider(repo, COMPANY_ID, "claude_response");
      await claudeGenerate();
      await assertCompanyMayUseProvider(repo, COMPANY_ID, "text_to_speech");
      await ttsSynthesize();
      await assertCompanyMayUseProvider(repo, COMPANY_ID, "whatsapp_send");
      await whatsappSend();
    }

    await expect(processInboundVoiceMessage()).rejects.toBeInstanceOf(EntitlementDeniedError);

    expect(sttTranscribe).not.toHaveBeenCalled();
    expect(claudeGenerate).not.toHaveBeenCalled();
    expect(ttsSynthesize).not.toHaveBeenCalled();
    expect(whatsappSend).not.toHaveBeenCalled();
  });
});
