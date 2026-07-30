import { AnthropicProvider } from "@dravonix/ai";
import { loadEnv } from "@dravonix/config";
import { createServiceRoleClient } from "@dravonix/database";
import { createLogger } from "@dravonix/observability";
import { PostgresKnowledgeRetriever } from "@dravonix/knowledge";
import { GraphApiWhatsAppProvider } from "@dravonix/whatsapp";
import {
  processMessageJob,
  type MessageConsumerDeps,
  type MessageJobPayload,
} from "./processMessageJob.js";
import { SupabaseEntitlementRepository } from "./repositories/supabaseEntitlementRepository.js";
import { SupabaseKnowledgeChunkRepository } from "./repositories/supabaseKnowledgeChunkRepository.js";
import { SupabaseMessageConsumerRepository } from "./repositories/supabaseMessageConsumerRepository.js";

/**
 * Minimal Cloudflare Queue consumer shapes this Worker depends on -- kept local
 * rather than pulling in @cloudflare/workers-types, matching apps/api's
 * minimal QueueLike convention.
 */
interface QueueMessage<T> {
  readonly body: T;
  ack(): void;
  retry(): void;
}

interface QueueBatch<T> {
  readonly messages: readonly QueueMessage<T>[];
}

export interface WorkerEnv {
  APP_ENV?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  META_ACCESS_TOKEN?: string;
}

function retryEntireBatch(batch: QueueBatch<MessageJobPayload>): void {
  for (const message of batch.messages) message.retry();
}

/**
 * Cloudflare Queues consumer entry point (composition root) for
 * dravonix-message-queue. Builds real dependencies from bound secrets, then
 * processes each job with processMessageJob -- all business logic lives there
 * and in packages/* (see apps/api/src/index.ts for the matching fetch-side
 * composition root).
 */
export default {
  async queue(batch: QueueBatch<MessageJobPayload>, env: WorkerEnv): Promise<void> {
    const platformEnv = loadEnv(env as unknown as Record<string, string | undefined>);
    const logger = createLogger({ environment: platformEnv.APP_ENV });

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
      logger.error("Message consumer misconfigured: Supabase credentials missing");
      retryEntireBatch(batch);
      return;
    }
    if (!env.ANTHROPIC_API_KEY) {
      logger.error("Message consumer misconfigured: ANTHROPIC_API_KEY missing");
      retryEntireBatch(batch);
      return;
    }
    if (!env.META_ACCESS_TOKEN) {
      logger.error("Message consumer misconfigured: META_ACCESS_TOKEN missing");
      retryEntireBatch(batch);
      return;
    }

    const supabase = createServiceRoleClient({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });

    const deps: MessageConsumerDeps = {
      repo: new SupabaseMessageConsumerRepository(supabase),
      entitlementRepo: new SupabaseEntitlementRepository(supabase),
      knowledgeRetriever: new PostgresKnowledgeRetriever(
        new SupabaseKnowledgeChunkRepository(supabase),
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
      logger,
    };

    for (const message of batch.messages) {
      try {
        await processMessageJob(deps, message.body);
        message.ack();
      } catch (error) {
        logger.error("Failed to process message job", {
          error: error instanceof Error ? error.message : String(error),
          conversationId: message.body.conversationId,
        });
        message.retry();
      }
    }
  },
};
