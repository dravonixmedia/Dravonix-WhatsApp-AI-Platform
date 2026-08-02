import type { AuditLogEntry, AuditLogWriter } from "@dravonix/observability";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role-backed AuditLogWriter (audit_logs has no INSERT policy for
 * `authenticated` at all -- every write goes through a trusted server-side
 * path, matching the RPCs' own audit inserts). `client` MUST be a
 * service_role Supabase client.
 */
export class SupabaseAuditLogWriter implements AuditLogWriter {
  constructor(private readonly client: SupabaseClient) {}

  async write(entry: AuditLogEntry): Promise<void> {
    const { error } = await this.client.from("audit_logs").insert({
      company_id: entry.companyId,
      actor_user_id: entry.actorUserId,
      actor_type: entry.actorType,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
    });
    if (error) throw new Error(error.message);
  }
}
