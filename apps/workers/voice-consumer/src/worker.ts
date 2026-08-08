import { AnthropicProvider } from "@dravonix/ai";
import { loadEnv } from "@dravonix/config";
import { createServiceRoleClient } from "@dravonix/database";
import { SupabaseHandoverWorkerRepository } from "@dravonix/handover";
import { createLogger } from "@dravonix/observability";
import { PostgresKnowledgeRetriever } from "@dravonix/knowledge";
import {
  ElevenLabsConfigurationError,
  ElevenLabsSpeechToTextProvider,
  ElevenLabsTextToSpeechProvider,
  validateElevenLabsApiKeyFormat,
} from "@dravonix/speech";
import { R2StorageProvider, type R2BucketLike } from "@dravonix/storage";
import { GraphApiWhatsAppProvider } from "@dravonix/whatsapp";
import { handleVoiceDlqBatch } from "./handleDlqBatch.js";
import {
  processVoiceJob,
  type VoiceConsumerDeps,
  type VoiceJobPayload,
} from "./processVoiceJob.js";
import { SupabaseEntitlementRepository } from "./repositories/supabaseEntitlementRepository.js";
import { SupabaseKnowledgeChunkRepository } from "./repositories/supabaseKnowledgeChunkRepository.js";
import { SupabaseVoiceConsumerRepository } from "./repositories/supabaseVoiceConsumerRepository.js";

/**
 * Minimal Cloudflare Queue consumer shapes this Worker depends on -- kept
 * local rather than pulling in @cloudflare/workers-types, matching apps/api
 * and message-consumer's minimal QueueLike convention.
 */
interface QueueMessage<T> {
  readonly body: T;
  ack(): void;
  retry(): void;
}

interface QueueBatch<T> {
  /** The real Cloudflare Queues queue name this batch was delivered from -- distinguishes the main voice queue from its dead-letter queue when both are bound to this same Worker script. */
  readonly queue: string;
  readonly messages: readonly QueueMessage<T>[];
}

export interface WorkerEnv {
  APP_ENV?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  META_ACCESS_TOKEN?: string;
  ELEVENLABS_API_KEY?: string;
  AUDIO_BUCKET?: R2BucketLike;
}

function retryEntireBatch(batch: QueueBatch<VoiceJobPayload>): void {
  for (const message of batch.messages) message.retry();
}

/**
 * Cloudflare Queues consumer entry point (composition root) for
 * dravonix-voice-queue. Mirrors apps/workers/message-consumer/src/worker.ts's
 * structure -- see that file for the equivalent text-message pipeline.
 */
export default {
  async queue(batch: QueueBatch<VoiceJobPayload>, env: WorkerEnv): Promise<void> {
    const platformEnv = loadEnv(env as unknown as Record<string, string | undefined>);
    const logger = createLogger({ environment: platformEnv.APP_ENV });

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
      logger.error("Voice consumer misconfigured: Supabase credentials missing");
      retryEntireBatch(batch);
      return;
    }

    // Dead-letter queue triage path (PHASE 9/10). Cloudflare Queues routes
    // ALL consumer bindings for this Worker script to this same exported
    // `queue()` function, so a DLQ batch is distinguished only by its
    // `batch.queue` name (ending in "-dlq" for both the staging and
    // production dead-letter queues configured in wrangler.toml). This
    // branch only needs Supabase credentials -- it never touches
    // Anthropic/Meta/ElevenLabs/R2, matching handleVoiceDlqBatch's "record
    // and ack, never replay" contract. NOT CURRENTLY REACHABLE: no
    // `[[queues.consumers]]` entry binds a "-dlq" queue to this Worker yet
    // (see wrangler.toml) -- this code exists and is tested, but is
    // intentionally not wired to a live binding pending explicit approval.
    if (batch.queue.endsWith("-dlq")) {
      const supabase = createServiceRoleClient({
        url: env.SUPABASE_URL,
        anonKey: env.SUPABASE_ANON_KEY,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      });
      await handleVoiceDlqBatch(
        {
          repo: new SupabaseVoiceConsumerRepository(supabase),
          logger,
          queueName: batch.queue,
        },
        batch,
      );
      return;
    }

    if (!env.ANTHROPIC_API_KEY) {
      logger.error("Voice consumer misconfigured: ANTHROPIC_API_KEY missing");
      retryEntireBatch(batch);
      return;
    }
    if (!env.META_ACCESS_TOKEN) {
      logger.error("Voice consumer misconfigured: META_ACCESS_TOKEN missing");
      retryEntireBatch(batch);
      return;
    }
    if (!env.ELEVENLABS_API_KEY) {
      logger.error("Voice consumer misconfigured: ELEVENLABS_API_KEY missing");
      retryEntireBatch(batch);
      return;
    }
    // Shape-only check (PHASE 6) -- catches an obviously malformed
    // credential before any ElevenLabs request is attempted. Never logs the
    // key itself; the caught error's message is already the safe
    // "voice_provider_configuration_error: ..." form.
    try {
      validateElevenLabsApiKeyFormat(env.ELEVENLABS_API_KEY);
    } catch (error) {
      if (error instanceof ElevenLabsConfigurationError) {
        logger.error("Voice consumer misconfigured", { reason: error.message });
        retryEntireBatch(batch);
        return;
      }
      throw error;
    }
    if (!env.AUDIO_BUCKET) {
      logger.error("Voice consumer misconfigured: AUDIO_BUCKET R2 binding missing");
      retryEntireBatch(batch);
      return;
    }

    const supabase = createServiceRoleClient({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });

    const deps: VoiceConsumerDeps = {
      repo: new SupabaseVoiceConsumerRepository(supabase),
      handoverRepo: new SupabaseHandoverWorkerRepository(supabase),
      entitlementRepo: new SupabaseEntitlementRepository(supabase),
      knowledgeRetriever: new PostgresKnowledgeRetriever(
        new SupabaseKnowledgeChunkRepository(supabase),
        { minRelevance: 0.01 },
      ),
      aiProvider: new AnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        model: platformEnv.ANTHROPIC_MODEL,
        maxTokens: platformEnv.ANTHROPIC_MAX_TOKENS,
      }),
      whatsappProvider: new GraphApiWhatsAppProvider({
        accessToken: env.META_ACCESS_TOKEN,
        graphApiVersion: platformEnv.META_GRAPH_API_VERSION,
      }),
      sttProvider: new ElevenLabsSpeechToTextProvider({
        apiKey: env.ELEVENLABS_API_KEY,
        modelId: platformEnv.ELEVENLABS_STT_MODEL_ID,
      }),
      ttsProvider: new ElevenLabsTextToSpeechProvider({
        apiKey: env.ELEVENLABS_API_KEY,
        defaultVoiceId: platformEnv.ELEVENLABS_VOICE_ID_DEFAULT,
        modelId: platformEnv.ELEVENLABS_TTS_MODEL_ID,
        malayalamVoiceId: platformEnv.ELEVENLABS_MALAYALAM_VOICE_ID,
        englishVoiceId: platformEnv.ELEVENLABS_ENGLISH_VOICE_ID,
        malayalamModelId: platformEnv.ELEVENLABS_MALAYALAM_MODEL_ID,
        pronunciationDictionaryId: platformEnv.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID,
        pronunciationDictionaryVersionId:
          platformEnv.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID,
      }),
      storageProvider: new R2StorageProvider(env.AUDIO_BUCKET),
      logger,
      voiceReplyMode: platformEnv.VOICE_REPLY_MODE,
      queueName: batch.queue,
    };

    for (const message of batch.messages) {
      try {
        await processVoiceJob(deps, message.body);
        message.ack();
      } catch (error) {
        logger.error("Failed to process voice job", {
          error: error instanceof Error ? error.message : String(error),
          conversationId: message.body.conversationId,
        });
        message.retry();
      }
    }
  },
};
