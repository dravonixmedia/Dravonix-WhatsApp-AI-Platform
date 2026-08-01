import { AnthropicProvider } from "@dravonix/ai";
import { loadEnv } from "@dravonix/config";
import { createServiceRoleClient } from "@dravonix/database";
import { createLogger } from "@dravonix/observability";
import { PostgresKnowledgeRetriever } from "@dravonix/knowledge";
import {
  fetchGoogleAccessToken,
  parseGoogleServiceAccountJson,
  GoogleTextToSpeechProvider,
  WhisperSpeechToTextProvider,
} from "@dravonix/speech";
import { R2StorageProvider, type R2BucketLike } from "@dravonix/storage";
import { GraphApiWhatsAppProvider } from "@dravonix/whatsapp";
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
  readonly messages: readonly QueueMessage<T>[];
}

const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface WorkerEnv {
  APP_ENV?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  META_ACCESS_TOKEN?: string;
  GOOGLE_CLOUD_CREDENTIALS?: string;
  OPENAI_API_KEY?: string;
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
    if (!env.GOOGLE_CLOUD_CREDENTIALS) {
      logger.error("Voice consumer misconfigured: GOOGLE_CLOUD_CREDENTIALS missing");
      retryEntireBatch(batch);
      return;
    }
    if (!env.OPENAI_API_KEY) {
      logger.error("Voice consumer misconfigured: OPENAI_API_KEY missing");
      retryEntireBatch(batch);
      return;
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

    const googleAccount = parseGoogleServiceAccountJson(env.GOOGLE_CLOUD_CREDENTIALS);
    // Cached per-batch: TTS (voice replies) still uses Google, so this token
    // is fetched once and reused across calls rather than per-message.
    let cachedToken: Promise<string> | null = null;
    const getAccessToken = (): Promise<string> => {
      cachedToken ??= fetchGoogleAccessToken(googleAccount, GOOGLE_CLOUD_SCOPE).then(
        (r) => r.access_token,
      );
      return cachedToken;
    };

    const deps: VoiceConsumerDeps = {
      repo: new SupabaseVoiceConsumerRepository(supabase),
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
      sttProvider: new WhisperSpeechToTextProvider({ apiKey: env.OPENAI_API_KEY }),
      ttsProvider: new GoogleTextToSpeechProvider({
        getAccessToken,
        defaultVoice: platformEnv.GOOGLE_TTS_VOICE_DEFAULT,
      }),
      storageProvider: new R2StorageProvider(env.AUDIO_BUCKET),
      logger,
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
