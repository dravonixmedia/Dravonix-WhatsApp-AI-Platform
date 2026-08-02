import { loadEnv } from "@dravonix/config";
import { createServiceRoleClient } from "@dravonix/database";
import { SupabaseHandoverWorkerRepository } from "@dravonix/handover";
import { createLogger } from "@dravonix/observability";
import { runReconciliation } from "./reconcile.js";

export interface WorkerEnv {
  APP_ENV?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

interface ScheduledEvent {
  readonly cron: string;
  readonly scheduledTime: number;
}

/**
 * Cloudflare Cron Trigger entry point (composition root) for
 * dravonix-outbound-reconciler (Human Handover Inbox final plan section 14).
 * Mirrors apps/workers/message-consumer/src/worker.ts's composition-root
 * structure -- all actual logic lives in reconcile.ts and
 * @dravonix/handover's expireStaleOutboundSends RPC call.
 */
export default {
  async scheduled(_event: ScheduledEvent, env: WorkerEnv): Promise<void> {
    const platformEnv = loadEnv(env as unknown as Record<string, string | undefined>);
    const logger = createLogger({ environment: platformEnv.APP_ENV });

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
      logger.error("Outbound reconciler misconfigured: Supabase credentials missing");
      return;
    }

    const supabase = createServiceRoleClient({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });

    try {
      await runReconciliation({
        handoverRepo: new SupabaseHandoverWorkerRepository(supabase),
        logger,
      });
    } catch (error) {
      logger.error("Reconciliation pass failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
