import { loadEnv } from "@dravonix/config";
import { createServiceRoleClient } from "@dravonix/database";
import { createLogger } from "@dravonix/observability";
import { createApp } from "./app.js";
import type { MessageJobPayload, VoiceJobPayload } from "./queuePayloads.js";
import { SupabaseWhatsAppIngestRepository } from "./repositories/supabaseWhatsAppIngestRepository.js";

/** Minimal Cloudflare Queue binding shape this Worker depends on. */
interface QueueLike<T> {
  send(message: T): Promise<void>;
}

export interface WorkerEnv {
  APP_ENV?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
  // Optional: absent until the corresponding queues exist in this Cloudflare
  // account and their bindings are uncommented in wrangler.toml (see
  // CLOUDFLARE_SETUP.md). Guarded below rather than assumed present, so a
  // missing binding fails with a clear message instead of a runtime crash.
  MESSAGE_QUEUE?: QueueLike<MessageJobPayload>;
  VOICE_QUEUE?: QueueLike<VoiceJobPayload>;
}

/**
 * Cloudflare Workers entry point (composition root). Builds real dependencies
 * from bound secrets/services. Kept intentionally thin -- all logic lives in
 * app.ts, whatsappWebhookHandler.ts, and packages/* so it is testable without
 * a Workers runtime (see apps/api/test).
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const platformEnv = loadEnv(env as unknown as Record<string, string | undefined>);
    const logger = createLogger({ environment: platformEnv.APP_ENV });

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
      return new Response("Server misconfigured: Supabase credentials missing", { status: 500 });
    }
    if (!env.META_APP_SECRET || !env.META_VERIFY_TOKEN) {
      return new Response("Server misconfigured: Meta credentials missing", { status: 500 });
    }
    // MESSAGE_QUEUE/VOICE_QUEUE are intentionally not required here: webhook
    // verification, signature checks, dedup, and persistence all work without
    // them. Their absence only degrades one specific capability (handing a
    // message off for AI/voice processing), logged per-request inside
    // whatsappWebhookHandler.ts rather than blocking the entire Worker.
    if (!env.MESSAGE_QUEUE || !env.VOICE_QUEUE) {
      logger.warn(
        "MESSAGE_QUEUE/VOICE_QUEUE not configured -- inbound messages will be persisted but not processed",
      );
    }

    const supabase = createServiceRoleClient({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });
    const repo = new SupabaseWhatsAppIngestRepository(supabase);

    const app = createApp({
      health: {
        checkDatabase: async () => {
          const { error } = await supabase.from("companies").select("id").limit(1);
          return !error;
        },
      },
      whatsappWebhook: {
        appSecret: env.META_APP_SECRET,
        verifyToken: env.META_VERIFY_TOKEN,
        repo,
        messageQueue: env.MESSAGE_QUEUE,
        voiceQueue: env.VOICE_QUEUE,
        logger,
      },
    });

    return app.fetch(request);
  },
};
