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
  MESSAGE_QUEUE: QueueLike<MessageJobPayload>;
  VOICE_QUEUE: QueueLike<VoiceJobPayload>;
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
