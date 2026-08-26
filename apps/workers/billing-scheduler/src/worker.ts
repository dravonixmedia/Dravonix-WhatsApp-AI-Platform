import { loadEnv } from "@dravonix/config";
import { createServiceRoleClient } from "@dravonix/database";
import { createLogger } from "@dravonix/observability";
import { SupabaseBillingSchedulerRepository } from "./billingRepository.js";
import { runBillingLifecycle } from "./runBillingLifecycle.js";

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
 * dravonix-billing-scheduler (Phase 6C). Mirrors
 * apps/workers/outbound-reconciler/src/worker.ts's composition-root
 * structure exactly -- all actual logic lives in runBillingLifecycle.ts and
 * the migration-30 RPCs it calls.
 */
export default {
  async scheduled(_event: ScheduledEvent, env: WorkerEnv): Promise<void> {
    const platformEnv = loadEnv(env as unknown as Record<string, string | undefined>);
    const logger = createLogger({ environment: platformEnv.APP_ENV });

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
      logger.error("Billing scheduler misconfigured: Supabase credentials missing");
      return;
    }

    const supabase = createServiceRoleClient({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });

    try {
      const result = await runBillingLifecycle({
        billingRepo: new SupabaseBillingSchedulerRepository(supabase),
        logger,
      });
      logger.info("Billing lifecycle pass complete", result as unknown as Record<string, unknown>);
    } catch (error) {
      logger.error("Billing lifecycle pass failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
